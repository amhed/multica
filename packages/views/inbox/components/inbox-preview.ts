import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { stripMentionMarkdown } from "../../issues/utils/strip-mention-markdown";

/** Inbox bodies are already capped by the server, sometimes inside a mention URL. */
export function inboxCommentPreview(body: string): string {
  const text = stripMentionMarkdown(body).replace(
    /\[((?:\\.|[^\]])+)\]\(mention:\/\/[^)]*$/g,
    (_match, label: string) => label.replace(/\\([[\]])/g, "$1"),
  );
  const parts: string[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "html") return;
    if (node.type === "image" || node.type === "imageReference") { parts.push(node.alt ?? ""); return; }
    if (node.type === "break") parts.push(" ");
    if ("value" in node) parts.push(node.value + (node.type === "code" ? " " : ""));
    if ("children" in node) {
      for (const child of node.children) visit(child);
      if (["paragraph", "heading", "listItem", "code", "blockquote"].includes(node.type)) parts.push(" ");
    }
  };
  visit(fromMarkdown(text));
  return parts.join("").replace(/\s+/g, " ").trim();
}
