/**
 * Test-only fix for happy-dom: its `Node.prototype.nodeName` getter returns an empty name; only the
 * subclasses (`Element`, `Text`, …) override it. DOMPurify reads the `Node` getter, so under
 * happy-dom it would treat every node as unknown and drop the first node of each message. Real
 * browsers (the WebKit webview) define the getter correctly and never load this file.
 */
if (typeof Node !== "undefined") {
  const base = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName");
  const baseGetter = base?.get;
  if (base && baseGetter) {
    Object.defineProperty(Node.prototype, "nodeName", {
      ...base,
      get(this: Node) {
        // The most specific getter of this node's own class.
        for (let p = Object.getPrototypeOf(this); p && p !== Node.prototype; ) {
          const getter = Object.getOwnPropertyDescriptor(p, "nodeName")?.get;
          if (getter) return getter.call(this);
          p = Object.getPrototypeOf(p);
        }
        return baseGetter.call(this);
      },
    });
  }
}
