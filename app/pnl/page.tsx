import type { Metadata } from "next";
import { PnlScreen } from "@/components/pnl/pnl-screen";

export const metadata: Metadata = {
    title: "PnL · Trade Everything",
    description: "Your balance over time, and every trade and deposit behind it.",
};

export default function PnlPage() {
    return <PnlScreen />;
}
