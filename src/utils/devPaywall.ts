// In-page stand-in for the host paywall, shown only in standalone `wavedash
// dev`. Lets a developer drive both branches of their purchase flow with no
// real payment; the caller persists a confirmed purchase server-side.

const Z_INDEX = 2147483647;

/** Resolves true on simulated purchase, false on cancel (or no DOM). */
export function showDevPaywall(contentIdentifier: string): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:" +
      Z_INDEX +
      ";display:flex;align-items:center;justify-content:center;" +
      "background:rgba(8,10,18,0.72);font:14px ui-sans-serif,system-ui,sans-serif;color:#e2e8f0";

    const card = document.createElement("div");
    card.style.cssText =
      "max-width:420px;width:calc(100% - 48px);background:#11151f;border:1px solid #2a3344;" +
      "border-radius:12px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,0.5);box-sizing:border-box";

    const badge = document.createElement("p");
    badge.textContent = "wavedash dev — simulated purchase";
    badge.style.cssText =
      "margin:0 0 12px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#7c8aa5";

    const title = document.createElement("p");
    title.textContent = "Unlock paid content?";
    title.style.cssText =
      "margin:0 0 8px;font-size:18px;font-weight:600;color:#f1f5f9";

    const body = document.createElement("p");
    body.style.cssText = "margin:0 0 20px;line-height:1.5;color:#cbd5e1";
    body.append(
      document.createTextNode("This game is requesting purchase of “")
    );
    const id = document.createElement("code");
    id.textContent = contentIdentifier;
    id.style.cssText =
      "background:#1c2433;border-radius:4px;padding:1px 6px;color:#93c5fd";
    body.append(
      id,
      document.createTextNode(
        "”. No real payment happens in dev — simulate the outcome to test your flow."
      )
    );

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:12px;justify-content:flex-end";

    const baseBtn =
      "border-radius:8px;padding:9px 18px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid transparent";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.cssText =
      baseBtn + ";background:transparent;border-color:#374151;color:#cbd5e1";
    const buy = document.createElement("button");
    buy.type = "button";
    buy.textContent = "Simulate purchase";
    buy.style.cssText = baseBtn + ";background:#2563eb;color:#fff";

    buttons.append(cancel, buy);
    card.append(badge, title, body, buttons);
    overlay.append(card);

    let settled = false;
    const finish = (purchased: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(purchased);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };

    cancel.addEventListener("click", () => finish(false));
    buy.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKeyDown, true);

    document.body.append(overlay);
  });
}
