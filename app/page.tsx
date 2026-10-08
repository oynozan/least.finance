import { ConnectWallet } from "@/components/connect-wallet";
import { TradeScreen } from "@/components/trade/trade-screen";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <TradeScreen />
      <ConnectWallet />
    </main>
  );
}
