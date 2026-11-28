/** A transient, non-modal notice, outside panels that can be hidden or clipped. */
export class Toast {
  private readonly element: HTMLElement;
  private readonly message: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(doc: Document) {
    this.element = doc.createElement("div");
    this.element.className = "hilo-toast";
    this.element.hidden = true;
    this.element.setAttribute("role", "status");
    this.element.setAttribute("aria-live", "polite");
    this.element.setAttribute("aria-atomic", "true");
    const icon = doc.createElement("span");
    icon.className = "hilo-toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52" fill="none"><path d="M22.5 6.5a4 4 0 0 1 7 0l20 35A4 4 0 0 1 46 47H6a4 4 0 0 1-3.5-5.5l20-35Z" fill="#FFD15C" stroke="#D6A537" stroke-width="1"/><path d="M26 18v13" stroke="#513C14" stroke-width="4" stroke-linecap="round"/><circle cx="26" cy="38" r="2.3" fill="#513C14"/></svg>';
    this.message = doc.createElement("p");
    this.message.className = "hilo-toast-message";
    this.element.append(icon, this.message);
    doc.body.append(this.element);
  }

  show(message: string): void {
    clearTimeout(this.timer);
    this.message.textContent = message;
    this.element.hidden = false;
    this.timer = setTimeout(() => this.hide(), 5000);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.element.hidden = true;
  }

  destroy(): void {
    this.hide();
    this.element.remove();
  }
}
