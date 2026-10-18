/** How long Privy may take to become ready before the person is told it isn't loading. */
export const PRIVY_READY_MS = 10_000;

export const PRIVY_NOT_LOADING = "The sign-in service didn't load. Check your connection and reload the page.";

/** What Privy's sign-in error code means for the person; a code not known here is shown as it is. */
export function loginProblem(code: string): string {
    switch (code) {
        case "exited_auth_flow":
            return "You closed the sign-in window.";
        case "unknown_connect_wallet_error":
        case "generic_connect_wallet_error":
            return "Your wallet couldn't connect. Unlock it, or try another wallet.";
        case "missing_or_invalid_privy_app_id":
            return "Sign-in isn't set up correctly on our side (the Privy app id is invalid).";
        case "too_many_requests":
            return "Too many sign-in attempts. Wait a minute and try again.";
        case "client_request_timeout":
        case "captcha_timeout":
            return "The sign-in service didn't answer. Try again.";
        case "allowlist_rejected":
            return "This wallet isn't allowed to sign in.";
        case "max_accounts_reached":
            return "Sign-ups are full right now.";
        case "session_storage_unavailable":
            return "Your browser is blocking storage, which signing in needs.";
        case "unsupported_wallet_type":
            return "That kind of wallet isn't supported.";
        default:
            return `Couldn't sign in (${code}).`;
    }
}
