"use client";

import { useEffect } from "react";

/** A page that threw while rendering: says so, names the reference the server log also carries, and offers another try. */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
    useEffect(() => {
        // The digest matches the line in the Next server's own log
        console.error(`Page error${error.digest ? ` (ref ${error.digest})` : ""}:`, error);
    }, [error]);

    return (
        <main className="grid min-h-[60vh] place-items-center px-4 text-center">
            <div>
                <p className="text-[17px]">
                    Something broke on this page{error.digest ? ` (ref ${error.digest})` : ""}.
                </p>
                <p className="mt-2 text-[15px] text-muted">Your balance and trades are safe. Try again, or reload.</p>
                <button type="button" className="mt-5 rounded-full bg-pill px-6 py-3 text-[15px]" onClick={retry}>
                    Try again
                </button>
            </div>
        </main>
    );
}
