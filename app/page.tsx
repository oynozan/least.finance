import { HeroHeading } from "@/components/hero-heading";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <HeroHeading />
    </main>
  );
}
