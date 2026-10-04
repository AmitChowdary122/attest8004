import { useState } from "react";
import { copyText, downloadJson, errorText, prettyJson } from "./exportJson.ts";

/** A public JSON document with Copy and Download buttons. */
export function JsonExport({ label, fileName, value }: { label: string; fileName: string; value: unknown }) {
  const text = prettyJson(value);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  return (
    <div className="export">
      <div className="buttons">
        <button
          type="button"
          onClick={async () => {
            try {
              await copyText(text);
              setCopied(true);
              setCopyError(null);
            } catch (e) {
              setCopyError(`couldn't copy (${errorText(e)}): download it, or select the text below`);
            }
          }}
        >
          {copied ? `Copied ${label}` : `Copy ${label}`}
        </button>
        <button type="button" onClick={() => downloadJson(fileName, text)}>
          Download {label}
        </button>
      </div>
      {copyError && <p className="error">{copyError}</p>}
      <pre>{text}</pre>
    </div>
  );
}
