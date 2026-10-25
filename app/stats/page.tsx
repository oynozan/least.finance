import type { Metadata } from "next";
import { StatsScreen } from "@/components/stats/stats-screen";

export const metadata: Metadata = {
    title: "Stats",
    robots: { index: false, follow: false },
};

export default function StatsPage() {
    return <StatsScreen />;
}
