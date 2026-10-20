import { createContext, useContext, useState, type ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  /** If set, the user must type this exact text to enable the confirm button. */
  typeToConfirm?: string;
}

type Ask = (o: ConfirmOptions) => Promise<string | null>;
const Ctx = createContext<Ask>(async () => null);

/** In-app confirmation sheet (browser confirm()/prompt() are unreliable in embedded views). */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ o: ConfirmOptions; resolve: (v: string | null) => void } | null>(null);
  const [text, setText] = useState("");
  const ask: Ask = (o) => new Promise((resolve) => { setText(""); setReq({ o, resolve }); });
  const close = (v: string | null) => { req?.resolve(v); setReq(null); };
  const o = req?.o;
  const ok = !o?.typeToConfirm || text.trim() === o.typeToConfirm;
  return (
    <Ctx.Provider value={ask}>
      {children}
      {o && (
        <div className="sheet-backdrop" onClick={() => close(null)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-title">{o.title}</h3>
            {o.body && <p className="muted">{o.body}</p>}
            {o.typeToConfirm && (
              <input id="confirm-input" className="input" autoFocus autoCapitalize="characters" placeholder={`Type ${o.typeToConfirm}`} value={text} onChange={(e) => setText(e.target.value)} />
            )}
            <div className="actions" style={{ marginTop: 14 }}>
              <button className="btn" onClick={() => close(null)}>Cancel</button>
              <button className={`btn ${o.danger ? "danger" : ""}`} disabled={!ok} onClick={() => close(text || "ok")}>{o.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useConfirm = () => useContext(Ctx);
