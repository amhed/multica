import { create } from "zustand";

const EMPTY_COLLAPSED: ReadonlySet<string> = new Set();
interface InboxViewState {
  collapsedByView: Record<string, ReadonlySet<string>>;
  setCollapsed: (viewKey: string, key: string, collapsed: boolean) => void;
}

export const useInboxViewStore = create<InboxViewState>()((set) => ({
  collapsedByView: {},
  setCollapsed: (viewKey, key, collapsed) => set(state => {
    const next = new Set(state.collapsedByView[viewKey]);
    if (collapsed) next.add(key);
    else next.delete(key);
    return { collapsedByView: { ...state.collapsedByView, [viewKey]: next } };
  }),
}));

export function useInboxCollapsedKeys(viewKey: string) {
  return useInboxViewStore(state => state.collapsedByView[viewKey]) ?? EMPTY_COLLAPSED;
}
