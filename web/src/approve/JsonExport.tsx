import { useState } from "react";
import { copyText, downloadJson, prettyJson } from "./exportJson.ts";

/** A public JSON document with Copy and Download buttons. */
export function JsonExport({ label, fileName, value }: { label: string; fileName: string; value: unknown }) {
  const text = prettyJson(value);
  const [copied, setCopied] = useState(false);
  return (
    <div className="export">
      <div className="buttons">
        <button
          type="button"
          onClick={async () => {
            await copyText(text);
            setCopied(true);
          }}
        >
          {copied ? `Copied ${label}` : `Copy ${label}`}
        </button>
        <button type="button" onClick={() => downloadJson(fileName, text)}>
          Download {label}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}
