/** Recognize paired ** markers left as text when punctuation rules reject CJK boundaries. */
type Node = { type: string; value?: string; children?: Node[] };
export function cjkStrong() {
  return (tree: Node) => {
    function visit(node: Node) {
      if (!node.children) return;
      const children: Node[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) { visit(child); children.push(child); continue; }
        const expression = /\*\*(?=\S)([^\n]*?\S)\*\*/g;
        let start = 0;
        let match: RegExpExecArray | null;
        while ((match = expression.exec(child.value))) {
          if (match.index > start) children.push({ type: "text", value: child.value.slice(start, match.index) });
          children.push({ type: "strong", children: [{ type: "text", value: match[1]! }] });
          start = expression.lastIndex;
        }
        if (start < child.value.length) children.push({ type: "text", value: child.value.slice(start) });
      }
      node.children = children;
    }
    visit(tree);
  };
}
