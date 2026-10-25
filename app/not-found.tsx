import type { Metadata } from "next";
import { NotFoundSentence } from "@/components/not-found-sentence";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
    return (
        <main className={styles.main}>
            <h1 className="sr-only">Page not found</h1>
            <NotFoundSentence />
        </main>
    );
}
