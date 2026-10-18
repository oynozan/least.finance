"use client";

import { useEffect } from "react";

/** The page itself (the layout above every page) threw: it has to bring its own document and styles. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
    useEffect(() => {
        console.error(`App error${error.digest ? ` (ref ${error.digest})` : ""}:`, error);
    }, [error]);

    return (
        <html lang="en">
            <body>
                <style>{`
                    :root { color-scheme: light dark; }
                    body { margin: 0; min-height: 100vh; display: grid; place-items: center; text-align: center;
                        font-family: system-ui, sans-serif; background: Canvas; color: CanvasText; padding: 0 16px; }
                    p { margin: 0 0 8px; font-size: 17px; }
                    .quiet { font-size: 15px; opacity: 0.65; }
                    button { margin-top: 16px; padding: 12px 24px; border-radius: 999px; border: 0; font-size: 15px;
                        cursor: pointer; background: ButtonFace; color: ButtonText; }
                `}</style>
                <div>
                    <p>Something broke{error.digest ? ` (ref ${error.digest})` : ""}.</p>
                    <p className="quiet">Your balance and trades are safe. Try again, or reload the page.</p>
                    <button type="button" onClick={retry}>
                        Try again
                    </button>
                </div>
            </body>
        </html>
    );
}
