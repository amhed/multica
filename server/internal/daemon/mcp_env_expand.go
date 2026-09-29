package daemon

import (
	"bytes"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

// mcpEnvRefRe matches Claude Code's MCP placeholder syntax: ${NAME} and
// ${NAME:-default}. A bare $NAME is deliberately not a placeholder.
var mcpEnvRefRe = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}`)

// expandAgentMcpConfigForProvider fills ${VAR} placeholders in an agent's
// mcp_config from the agent's own custom_env, for runtimes that would
// otherwise send the placeholder text verbatim (Codex, Grok, ...). Claude Code
// expands these itself from its process env, so its config is returned as-is
// and no resolved secret lands in its temp config file.
//
// Only the fields Claude Code expands are touched — command, args, env values,
// url, and header values — so one config behaves the same on every runtime.
// Values come from custom_env minus daemon-blocklisted keys: a config can never
// pull daemon-internal or host variables into a header or URL. Unresolvable
// names are left as the literal placeholder and returned (sorted, unique) so
// the caller can warn; they never fail the task.
func expandAgentMcpConfigForProvider(provider string, raw json.RawMessage, customEnv map[string]string) (json.RawMessage, []string) {
	if provider == "claude" || !bytes.Contains(raw, []byte("${")) {
		return raw, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return raw, nil
	}
	servers, ok := doc["mcpServers"].(map[string]any)
	if !ok {
		return raw, nil
	}

	env := sanitizeAgentEnv(customEnv)
	missing := map[string]struct{}{}
	expand := func(s string) string {
		return mcpEnvRefRe.ReplaceAllStringFunc(s, func(ref string) string {
			m := mcpEnvRefRe.FindStringSubmatch(ref)
			name, hasDefault := m[1], strings.Contains(ref, ":-")
			// Shell semantics: ${NAME:-default} falls back when NAME is unset
			// or empty; a plain ${NAME} that is set to "" expands to "".
			if v, set := env[name]; set && (v != "" || !hasDefault) {
				return v
			}
			if hasDefault {
				return m[2]
			}
			missing[name] = struct{}{}
			return ref
		})
	}
	for _, entry := range servers {
		server, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		for _, key := range []string{"command", "url"} {
			if s, ok := server[key].(string); ok {
				server[key] = expand(s)
			}
		}
		if args, ok := server["args"].([]any); ok {
			for i, arg := range args {
				if s, ok := arg.(string); ok {
					args[i] = expand(s)
				}
			}
		}
		for _, key := range []string{"env", "headers"} {
			if values, ok := server[key].(map[string]any); ok {
				for name, value := range values {
					if s, ok := value.(string); ok {
						values[name] = expand(s)
					}
				}
			}
		}
	}

	out, err := json.Marshal(doc)
	if err != nil {
		return raw, nil
	}
	if len(missing) == 0 {
		return out, nil
	}
	names := make([]string, 0, len(missing))
	for name := range missing {
		names = append(names, name)
	}
	sort.Strings(names)
	return out, names
}
