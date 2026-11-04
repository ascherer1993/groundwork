import { useEffect } from "react";
import { Overlays } from "./components/Overlays";
import { VaultView } from "./components/VaultView";
import { Welcome } from "./components/Welcome";
import { installShortcuts } from "./lib/shortcuts";
import { useVault } from "./state/vault";

export default function App() {
  const status = useVault((s) => s.status);
  const init = useVault((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(installShortcuts, []);

  if (status === "loading") return <div className="loading" aria-busy="true" />;
  return (
    <>
      {status === "vault" ? <VaultView /> : <Welcome />}
      <Overlays />
    </>
  );
}
