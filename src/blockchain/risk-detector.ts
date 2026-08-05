import type { AuditFinding, AuditModule, Severity } from "./audit-analyzer.js";
import type { WalletAuditSnapshot } from "./snapshot-store.js";
import type { WalletPowerScore } from "./power-index.js";

export type RiskCategory =
  | "massive-unstaking"
  | "power-concentration"
  | "sr-rotation"
  | "silent-accumulation"
  | "healthy-distribution";

const UNSTAKING_THRESHOLD_PCT = 20;
const CONCENTRATION_THRESHOLD_PCT = 50;
const SR_VOTE_LOSS_THRESHOLD_PCT = 30;
const TOP_N_CONCENTRATION = 5;
const TOP_N_ACCUMULATION = 20;

function makeFinding(
  severity: Severity,
  module: AuditModule,
  category: RiskCategory,
  title: string,
  description: string,
  evidence: Readonly<Record<string, unknown>>,
  recommendation: string | null,
): AuditFinding {
  return Object.freeze({
    analyzerName: "risk-detector",
    module,
    severity,
    category,
    title,
    description,
    evidence,
    recommendation,
  });
}

export function detectRisks(
  current: WalletAuditSnapshot,
  previous: WalletAuditSnapshot | null,
): readonly AuditFinding[] {
  const findings: AuditFinding[] = [];

  checkPowerConcentration(current, findings);

  if (previous) {
    checkMassiveUnstaking(current, previous, findings);
    checkSRRotation(current, previous, findings);
    checkSilentAccumulation(current, previous, findings);
    checkHealthyDistribution(current, previous, findings);
  }

  return Object.freeze(findings);
}

function checkPowerConcentration(
  current: WalletAuditSnapshot,
  findings: AuditFinding[],
): void {
  const rankings = current.powerIndex.rankings;
  if (rankings.length < TOP_N_CONCENTRATION) return;

  const totalPower = rankings.reduce((sum, r) => sum + r.powerScore, 0);
  if (totalPower <= 0) return;

  const topNPower = rankings
    .slice(0, TOP_N_CONCENTRATION)
    .reduce((sum, r) => sum + r.powerScore, 0);

  const concentrationPct = (topNPower / totalPower) * 100;

  if (concentrationPct > CONCENTRATION_THRESHOLD_PCT) {
    const topAddresses = rankings
      .slice(0, TOP_N_CONCENTRATION)
      .map((r) => r.address);

    findings.push(
      makeFinding(
        "CRITICAL",
        "FUNDAMENTAL",
        "power-concentration",
        `Top ${TOP_N_CONCENTRATION} wallets control ${concentrationPct.toFixed(1)}% of network power`,
        `The ${TOP_N_CONCENTRATION} most powerful wallets collectively hold ${concentrationPct.toFixed(1)}% of the total power index, exceeding the ${CONCENTRATION_THRESHOLD_PCT}% threshold. This represents a centralization risk.`,
        {
          topNWallets: topAddresses,
          topNPower: Math.round(topNPower * 100) / 100,
          totalPower: Math.round(totalPower * 100) / 100,
          concentrationPct: Math.round(concentrationPct * 100) / 100,
          threshold: CONCENTRATION_THRESHOLD_PCT,
        },
        "Monitor power distribution and promote decentralization through community staking programs.",
      ),
    );
  }
}

function checkMassiveUnstaking(
  current: WalletAuditSnapshot,
  previous: WalletAuditSnapshot,
  findings: AuditFinding[],
): void {
  for (const [address, currentWallet] of current.registry.wallets) {
    const previousWallet = previous.registry.wallets.get(address);
    if (!previousWallet) continue;

    if (previousWallet.votingPower <= 0) continue;

    const reduction = previousWallet.votingPower - currentWallet.votingPower;
    if (reduction <= 0) continue;

    const reductionPct = (reduction / previousWallet.votingPower) * 100;

    if (reductionPct >= UNSTAKING_THRESHOLD_PCT) {
      findings.push(
        makeFinding(
          "CRITICAL",
          "INFRA",
          "massive-unstaking",
          `Massive unstaking detected: ${address}`,
          `Wallet ${address} reduced stake by ${reductionPct.toFixed(1)}% (from ${previousWallet.votingPower.toLocaleString()} to ${currentWallet.votingPower.toLocaleString()}). This exceeds the ${UNSTAKING_THRESHOLD_PCT}% threshold.`,
          {
            address,
            previousVotingPower: previousWallet.votingPower,
            currentVotingPower: currentWallet.votingPower,
            reduction,
            reductionPct: Math.round(reductionPct * 100) / 100,
            threshold: UNSTAKING_THRESHOLD_PCT,
          },
          "Investigate why this wallet is unstaking. Large unstaking events can destabilize the network.",
        ),
      );
    }
  }
}

function checkSRRotation(
  current: WalletAuditSnapshot,
  previous: WalletAuditSnapshot,
  findings: AuditFinding[],
): void {
  // Find wallets that were SRs in the previous snapshot
  for (const [address, prevWallet] of previous.registry.wallets) {
    if (!prevWallet.roles.includes("sr")) continue;

    const currentWallet = current.registry.wallets.get(address);
    if (!currentWallet) continue;
    if (prevWallet.votingPower <= 0) continue;

    const voteLoss = prevWallet.votingPower - currentWallet.votingPower;
    if (voteLoss <= 0) continue;

    const lossPct = (voteLoss / prevWallet.votingPower) * 100;

    if (lossPct >= SR_VOTE_LOSS_THRESHOLD_PCT) {
      const stillSR = currentWallet.roles.includes("sr");
      findings.push(
        makeFinding(
          "HIGH",
          "INFRA",
          "sr-rotation",
          `SR vote erosion: ${address} lost ${lossPct.toFixed(1)}% of votes`,
          `Super Representative ${address} lost ${lossPct.toFixed(1)}% of votes (from ${prevWallet.votingPower.toLocaleString()} to ${currentWallet.votingPower.toLocaleString()}).${stillSR ? "" : " This SR may lose their elected position."}`,
          {
            address,
            previousVotes: prevWallet.votingPower,
            currentVotes: currentWallet.votingPower,
            voteLoss,
            lossPct: Math.round(lossPct * 100) / 100,
            threshold: SR_VOTE_LOSS_THRESHOLD_PCT,
            stillElected: stillSR,
          },
          "Monitor this SR closely. Significant vote loss may indicate loss of community confidence.",
        ),
      );
    }
  }
}

function checkSilentAccumulation(
  current: WalletAuditSnapshot,
  previous: WalletAuditSnapshot,
  findings: AuditFinding[],
): void {
  const currentRankings = current.powerIndex.rankings;
  const previousAddresses = new Set(
    previous.powerIndex.rankings
      .slice(0, TOP_N_ACCUMULATION)
      .map((r: WalletPowerScore) => r.address),
  );

  const currentTop = currentRankings.slice(0, TOP_N_ACCUMULATION);

  for (const ranked of currentTop) {
    if (!previousAddresses.has(ranked.address)) {
      findings.push(
        makeFinding(
          "HIGH",
          "FUNDAMENTAL",
          "silent-accumulation",
          `New wallet entered top ${TOP_N_ACCUMULATION}: ${ranked.address}`,
          `Wallet ${ranked.address} entered the top ${TOP_N_ACCUMULATION} power rankings at rank #${ranked.rank} with a power score of ${ranked.powerScore.toFixed(2)}. This wallet was not in the previous top ${TOP_N_ACCUMULATION}.`,
          {
            address: ranked.address,
            rank: ranked.rank,
            powerScore: ranked.powerScore,
            topN: TOP_N_ACCUMULATION,
          },
          "Investigate the source of funds and governance activity for this newly prominent wallet.",
        ),
      );
    }
  }
}

function checkHealthyDistribution(
  current: WalletAuditSnapshot,
  previous: WalletAuditSnapshot,
  findings: AuditFinding[],
): void {
  const currentRankings = current.powerIndex.rankings;
  const previousRankings = previous.powerIndex.rankings;

  if (currentRankings.length < TOP_N_CONCENTRATION || previousRankings.length < TOP_N_CONCENTRATION) {
    return;
  }

  const currentTotal = currentRankings.reduce((sum, r) => sum + r.powerScore, 0);
  const previousTotal = previousRankings.reduce((sum, r) => sum + r.powerScore, 0);

  if (currentTotal <= 0 || previousTotal <= 0) return;

  const currentTopPower = currentRankings
    .slice(0, TOP_N_CONCENTRATION)
    .reduce((sum, r) => sum + r.powerScore, 0);
  const previousTopPower = previousRankings
    .slice(0, TOP_N_CONCENTRATION)
    .reduce((sum, r) => sum + r.powerScore, 0);

  const currentConcentration = (currentTopPower / currentTotal) * 100;
  const previousConcentration = (previousTopPower / previousTotal) * 100;

  if (currentConcentration < previousConcentration && currentConcentration <= CONCENTRATION_THRESHOLD_PCT) {
    findings.push(
      makeFinding(
        "INFO",
        "FUNDAMENTAL",
        "healthy-distribution",
        "Network power is becoming more distributed",
        `Top ${TOP_N_CONCENTRATION} concentration decreased from ${previousConcentration.toFixed(1)}% to ${currentConcentration.toFixed(1)}%. Power is dispersing across more wallets.`,
        {
          previousConcentration: Math.round(previousConcentration * 100) / 100,
          currentConcentration: Math.round(currentConcentration * 100) / 100,
          improvement: Math.round((previousConcentration - currentConcentration) * 100) / 100,
        },
        null,
      ),
    );
  }
}
