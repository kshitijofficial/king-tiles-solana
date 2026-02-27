import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Connection,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import "./App.css";
import { BackgroundMusic } from "./audio/BackgroundMusic";
import { useMoveSound } from "./audio/useMoveSound";
import { useKingPowerSound } from "./audio/useKingPowerSound";
import { useEmergencyCountdownSound } from "./audio/useEmergencyCountdownSound";
import { useBumpSound } from "./audio/useBumpSound";
import { useLaserSound } from "./audio/useLaserSound";
import { useBombSound } from "./audio/useBombSound";
import {
  BOMB_MARK,
  COLS,
  COIN_X_POSITIONS,
  EMPTY,
  ER_ENDPOINT,
  GAME_ID,
  KING_MARK,
  MEMO_PROGRAM_ID,
  PLAYER_COLORS,
  PLAYER_LABELS,
  POWERUP_MARK,
  REGISTRATION_FEE_LAMPORTS,
  RELAYER_URL,
} from "./game/constants";
import { buildMakeMoveIx, buildRegisterPlayerIx } from "./game/instructions";
import { getBoardPDA } from "./game/pda";
import { getWinningPlayerId } from "./game/winner";
import { CompletedGameSnapshot, GameStatus, PlayerInfo, TxTrace } from "./game/types";
import { formatTime, moveLabel } from "./utils/format";

type GameMode = {
  label: string;
  boardSideLen: number;
  maxPlayers: number;
  registrationFeeLamports: number;
  lamportsPerScore: number;
};

type ActiveGameSummary = {
  gameId: number;
  boardSideLen: number;
  maxPlayers: number;
  registrationFeeLamports: number;
  lamportsPerScore: number;
  isActive?: boolean;
  playersCount?: number;
  gameEndTimestamp?: number;
};

type GamesOverviewResponse = {
  ok?: boolean;
  activeGames?: ActiveGameSummary[];
  lastCompletedGame?: CompletedGameSnapshot | null;
  lastCompletedByMode?: Record<string, CompletedGameSnapshot>;
};

const GAME_MODES: GameMode[] = [
  {
    label: "8x8 - 2 Players",
    boardSideLen: 8,
    maxPlayers: 2,
    registrationFeeLamports: 1_000_000,
    lamportsPerScore: 29_000,
  },
  {
    label: "10x10 - 4 Players",
    boardSideLen: 10,
    maxPlayers: 4,
    registrationFeeLamports: 1_500_000,
    lamportsPerScore: 22_000,
  },
  {
    label: "12x12 - 6 Players",
    boardSideLen: 12,
    maxPlayers: 6,
    registrationFeeLamports: 2_000_000,
    lamportsPerScore: 18_000,
  },
];

const modeKey = (boardSideLen: number, maxPlayers: number): string =>
  `${boardSideLen}x${maxPlayers}`;

const modeKeyFromMode = (
  mode: Pick<GameMode, "boardSideLen" | "maxPlayers">
): string => modeKey(Number(mode.boardSideLen), Number(mode.maxPlayers));

const modeKeyFromSnapshot = (
  snapshot: Pick<CompletedGameSnapshot, "boardSideLen" | "maxPlayers">
): string | null => {
  const boardSideLen = Number(snapshot.boardSideLen ?? Number.NaN);
  const maxPlayers = Number(snapshot.maxPlayers ?? Number.NaN);
  if (!Number.isFinite(boardSideLen) || !Number.isFinite(maxPlayers)) return null;
  return modeKey(boardSideLen, maxPlayers);
};

const completedSnapshotRank = (
  snapshot: Pick<CompletedGameSnapshot, "completedAtIso" | "currentGameId">
): number => {
  const completedAtMs = Date.parse(snapshot.completedAtIso ?? "");
  if (Number.isFinite(completedAtMs)) return completedAtMs;
  const gameId = Number(snapshot.currentGameId ?? Number.NaN);
  return Number.isFinite(gameId) ? gameId : 0;
};

const mergeCompletedByMode = (
  base: Record<string, CompletedGameSnapshot>,
  incoming: Record<string, CompletedGameSnapshot>
): Record<string, CompletedGameSnapshot> => {
  const merged = { ...base };
  for (const [key, snapshot] of Object.entries(incoming)) {
    if (!snapshot) continue;
    const existing = merged[key];
    if (!existing || completedSnapshotRank(snapshot) >= completedSnapshotRank(existing)) {
      merged[key] = snapshot;
    }
  }
  return merged;
};

const extractCompletedByMode = (
  data: GamesOverviewResponse
): Record<string, CompletedGameSnapshot> => {
  let byMode: Record<string, CompletedGameSnapshot> = {};
  if (data?.lastCompletedByMode && typeof data.lastCompletedByMode === "object") {
    byMode = mergeCompletedByMode(byMode, data.lastCompletedByMode);
  }
  if (data?.lastCompletedGame) {
    const fallbackKey = modeKeyFromSnapshot(data.lastCompletedGame);
    if (fallbackKey) {
      byMode = mergeCompletedByMode(byMode, { [fallbackKey]: data.lastCompletedGame });
    }
  }
  return byMode;
};

function getBeamCells(
  fromPos: number,
  direction: number,
  board: number[],
  boardSize: number,
  cols: number,
  maxPlayers: number
): number[] {
  const cells: number[] = [];
  let pos = fromPos;
  for (let step = 0; step < boardSize; step++) {
    pos += direction;
    if (pos < 0 || pos >= boardSize) break;
    if (Math.abs(direction) === 1 && Math.floor(pos / cols) !== Math.floor(fromPos / cols)) break;
    cells.push(pos);
    const cell = board[pos];
    if (cell >= 1 && cell <= maxPlayers && cell !== board[fromPos]) break;
  }
  return cells;
}

type LeaderboardRow = {
  wallet: string;
  best_score: number;
  games_played: number;
};

const App: React.FC = () => {
  const { publicKey, sendTransaction } = useWallet();
  const { connection: devnetConnection } = useConnection();

  const erConnection = useMemo(
    () => new Connection(ER_ENDPOINT, "confirmed"),
    []
  );

  const sessionKeypair = useMemo(() => {
    if (!publicKey) return null;
    return Keypair.fromSeed(publicKey.toBytes());
  }, [publicKey]);

  const [gameStatus, setGameStatus] = useState<GameStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [countdown, setCountdown] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [registerPending, setRegisterPending] = useState(false);
  const [showKingNotif, setShowKingNotif] = useState(false);
  const [kingNotifKey, setKingNotifKey] = useState(0);
  const [showGameOverModal, setShowGameOverModal] = useState(false);
  const [showTransferAnim, setShowTransferAnim] = useState(false);
  const [endedGamePlayers, setEndedGamePlayers] = useState<PlayerInfo[]>([]);
  const [endedGamePlayerCount, setEndedGamePlayerCount] = useState(0);
  const [sessionFunded, setSessionFunded] = useState(false);
  const [infoTab, setInfoTab] = useState<"rules" | "rewards">("rules");
  const [showPowerupAcquired, setShowPowerupAcquired] = useState(false);
  const [powerupAcquiredKey, setPowerupAcquiredKey] = useState(0);
  const [showBombAnim, setShowBombAnim] = useState(false);
  const [bombAnimKey, setBombAnimKey] = useState(0);
  const [powerBeam, setPowerBeam] = useState<number[] | null>(null);
  const [showLanding, setShowLanding] = useState(true);
  const [selectedMode, setSelectedMode] = useState<GameMode | null>(null);
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null);
  const [activeGames, setActiveGames] = useState<ActiveGameSummary[]>([]);
  const [lastCompletedByMode, setLastCompletedByMode] =
    useState<Record<string, CompletedGameSnapshot>>({});
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);
  const powerBeamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kingNotifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const powerupNotifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastScoreRef = useRef<number>(0);
  const prevIsActiveRef = useRef<boolean | undefined>(undefined);
  const prevPlayerPositionsRef = useRef<Map<number, number> | null>(null);
  const prevPlayerScoresRef = useRef<Map<number, number> | null>(null);
  const prevPowerupScoresRef = useRef<Map<number, number> | null>(null);
  const prevPowerupScoresForLaserRef = useRef<Map<number, number> | null>(null);
  const prevFlatBoardRef = useRef<number[] | null>(null);
  const seenActiveGameIdsRef = useRef<Set<number>>(new Set());
  const kingStreakRef = useRef<Map<number, number>>(new Map());
  const kingTileIndexRef = useRef<number | null>(null);
  const lastShownGameOverGameIdRef = useRef<number | null>(null);
  const transferAnimShownGameIdsRef = useRef<Set<number>>(new Set());
  const payoutTxTraceByGameRef = useRef<
    Map<number, Pick<TxTrace, "rewardTxHash" | "rewardTxSolscanUrl">>
  >(new Map());

  const cachedBlockhashRef = useRef<{ blockhash: string; fetchedAt: number } | null>(null);
  const optimisticBoardRef = useRef<number[] | null>(null);
  const [optimisticBoard, setOptimisticBoard] = useState<number[] | null>(null);
  const moveDebounceRef = useRef<number>(0);
  const lastOptimisticMoveRef = useRef<number>(0);
  const OPTIMISTIC_HOLD_MS = 2000;

  const { playMoveSound } = useMoveSound(0.1);
  const { playKingPower } = useKingPowerSound(0.15);
  const { playEmergencyTick } = useEmergencyCountdownSound(0.17);
  const { playBumpSound } = useBumpSound(0.16);
  const { playLaserSound } = useLaserSound(0.15);
  const { playBombSound } = useBombSound(0.17);

  const selectedModeKey = useMemo(
    () => (selectedMode ? modeKeyFromMode(selectedMode) : null),
    [selectedMode]
  );

  const selectedModeCompleted = useMemo(() => {
    if (!selectedModeKey) return null;
    return lastCompletedByMode[selectedModeKey] ?? null;
  }, [lastCompletedByMode, selectedModeKey]);

  const displayGame = useMemo<CompletedGameSnapshot | GameStatus | null>(() => {
    if (gameStatus?.currentGameId !== null) return gameStatus;
    if (gameStatus?.lastCompletedGame) return gameStatus.lastCompletedGame;
    return selectedModeCompleted ?? null;
  }, [gameStatus, selectedModeCompleted]);

  useEffect(() => {
    const snapshots = [gameStatus?.lastCompletedGame, selectedModeCompleted];
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const gameId = Number(snapshot.currentGameId);
      if (!Number.isFinite(gameId)) continue;
      const rewardTxHash = snapshot.txTrace?.rewardTxHash;
      const rewardTxSolscanUrl = snapshot.txTrace?.rewardTxSolscanUrl;
      if (!rewardTxHash && !rewardTxSolscanUrl) continue;
      const existing = payoutTxTraceByGameRef.current.get(gameId);
      payoutTxTraceByGameRef.current.set(gameId, {
        rewardTxHash: rewardTxHash ?? existing?.rewardTxHash,
        rewardTxSolscanUrl: rewardTxSolscanUrl ?? existing?.rewardTxSolscanUrl,
      });
    }
  }, [gameStatus?.lastCompletedGame, selectedModeCompleted]);

  const settlementTargetGameId = useMemo<number | null>(() => {
    const activeGameId = Number(gameStatus?.currentGameId ?? Number.NaN);
    if (Number.isFinite(activeGameId)) return activeGameId;
    const selectedId = Number(selectedGameId ?? Number.NaN);
    if (Number.isFinite(selectedId)) return selectedId;
    return null;
  }, [gameStatus?.currentGameId, selectedGameId]);

  const settlement = useMemo<CompletedGameSnapshot | null>(() => {
    const candidates = [gameStatus?.lastCompletedGame, selectedModeCompleted].filter(
      (snapshot): snapshot is CompletedGameSnapshot => !!snapshot
    );
    if (!candidates.length) return null;
    if (!Number.isFinite(settlementTargetGameId ?? Number.NaN)) return null;

    const sameGameSnapshots = candidates.filter(
      (snapshot) => Number(snapshot.currentGameId) === Number(settlementTargetGameId)
    );
    if (!sameGameSnapshots.length) return null;

    const sortedByTime = [...sameGameSnapshots].sort((a, b) => {
      const aTs = Date.parse(a.completedAtIso ?? "");
      const bTs = Date.parse(b.completedAtIso ?? "");
      return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
    });
    const latest = sortedByTime[0];
    const mergedTxTrace = sameGameSnapshots.reduce<TxTrace>(
      (acc, snapshot) => ({ ...acc, ...snapshot.txTrace }),
      {}
    );

    const stickyTx = payoutTxTraceByGameRef.current.get(Number(settlementTargetGameId));
    const rewardTxHash = mergedTxTrace.rewardTxHash ?? stickyTx?.rewardTxHash;
    const rewardTxSolscanUrl = mergedTxTrace.rewardTxSolscanUrl ?? stickyTx?.rewardTxSolscanUrl;

    return {
      ...latest,
      txTrace: {
        ...mergedTxTrace,
        rewardTxHash,
        rewardTxSolscanUrl,
        rewardError:
          rewardTxHash || rewardTxSolscanUrl ? undefined : mergedTxTrace.rewardError,
      },
    };
  }, [gameStatus?.lastCompletedGame, selectedModeCompleted, settlementTargetGameId]);

  const myPlayerId = useMemo(() => {
    if (!sessionKeypair || !displayGame?.players) return null;
    const addr = sessionKeypair.publicKey.toBase58();
    const found = displayGame.players.find((p) => p.player === addr);
    return found ? found.id : null;
  }, [sessionKeypair, displayGame?.players]);

  const myScore = useMemo(() => {
    if (!myPlayerId || !displayGame?.players) return 0;
    const p = displayGame.players.find((x) => x.id === myPlayerId);
    return p ? Number(p.score) : 0;
  }, [myPlayerId, displayGame?.players]);

  const myPowerupScore = useMemo(() => {
    if (!myPlayerId || !displayGame?.players) return 0;
    const p = displayGame.players.find((x) => x.id === myPlayerId);
    return p ? Number(p.powerupScore ?? 0) : 0;
  }, [myPlayerId, displayGame?.players]);

  const boardSideLen = useMemo(() => {
    const fromDisplay = Number(displayGame?.boardSideLen ?? 0);
    if (fromDisplay > 0) return fromDisplay;
    return selectedMode?.boardSideLen ?? COLS;
  }, [displayGame?.boardSideLen, selectedMode]);

  const boardSize = useMemo(() => boardSideLen * boardSideLen, [boardSideLen]);

  const maxPlayers = useMemo(() => {
    const fromDisplay = Number(displayGame?.maxPlayers ?? 0);
    if (fromDisplay > 0) return fromDisplay;
    return selectedMode?.maxPlayers ?? 2;
  }, [displayGame?.maxPlayers, selectedMode]);

  const registrationFeeLamports = useMemo(() => {
    const fromDisplay = Number(displayGame?.registrationFeeLamports ?? 0);
    if (fromDisplay > 0) return fromDisplay;
    return selectedMode?.registrationFeeLamports ?? REGISTRATION_FEE_LAMPORTS;
  }, [displayGame?.registrationFeeLamports, selectedMode]);

  const backToLanding = useCallback(() => {
    setShowLanding(true);
    setSelectedMode(null);
    setSelectedGameId(null);
    setGameStatus(null);
    setError(null);
    optimisticBoardRef.current = null;
    setOptimisticBoard(null);
    setPowerBeam(null);
  }, []);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [`${new Date().toLocaleTimeString()} ${msg}`, ...prev].slice(0, 30));
  }, []);

  useEffect(() => {
    if (!sessionKeypair) {
      setSessionFunded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const bal = await devnetConnection.getBalance(sessionKeypair.publicKey);
        if (bal >= 0.003 * LAMPORTS_PER_SOL) {
          if (!cancelled) {
            setSessionFunded(true);
            addLog("Session key ready.");
          }
          return;
        }
        if (!publicKey || !sendTransaction) return;
        addLog("Funding session key via wallet transfer...");
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: sessionKeypair.publicKey,
            lamports: Math.round(0.01 * LAMPORTS_PER_SOL),
          })
        );
        const sig = await sendTransaction(tx, devnetConnection);
        await devnetConnection.confirmTransaction(sig, "confirmed");
        if (!cancelled) {
          setSessionFunded(true);
          addLog("Session key funded via wallet.");
        }
      } catch (e: any) {
        if (!cancelled)
          addLog("Failed to fund session key: " + (e?.message?.slice(0, 60) || ""));
      }
    })();
    return () => { cancelled = true; };
  }, [sessionKeypair, devnetConnection, publicKey, sendTransaction, addLog]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const { blockhash } = await erConnection.getLatestBlockhash();
        if (active) cachedBlockhashRef.current = { blockhash, fetchedAt: Date.now() };
      } catch {}
    };
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { active = false; clearInterval(id); };
  }, [erConnection]);

  useEffect(() => {
    if (!gameStatus?.board || !optimisticBoardRef.current) return;

    const serverBoard = gameStatus.board.flat();
    const optimistic = optimisticBoardRef.current;
    const holdExpired = Date.now() - lastOptimisticMoveRef.current > OPTIMISTIC_HOLD_MS;

    if (!myPlayerId) {
      optimisticBoardRef.current = null;
      setOptimisticBoard(null);
      return;
    }

    const serverPos = serverBoard.indexOf(myPlayerId);
    const optimisticPos = optimistic.indexOf(myPlayerId);
    const serverCaughtUp = serverPos >= 0 && serverPos === optimisticPos;

    if (serverCaughtUp || holdExpired) {
      optimisticBoardRef.current = null;
      setOptimisticBoard(null);
    }
  }, [gameStatus?.board, myPlayerId]);

  useEffect(() => {
    if (!myPlayerId || !displayGame?.isActive || !displayGame?.playersCount) {
      if (kingNotifTimerRef.current) {
        clearTimeout(kingNotifTimerRef.current);
        kingNotifTimerRef.current = null;
      }
      setShowKingNotif(false);
      return;
    }
    const p = displayGame.players?.find((x) => x.id === myPlayerId);
    const score = p ? Number(p.score) : 0;
    if (score > lastScoreRef.current) {
      lastScoreRef.current = score;
      if (powerupNotifTimerRef.current) {
        clearTimeout(powerupNotifTimerRef.current);
        powerupNotifTimerRef.current = null;
      }
      setShowPowerupAcquired(false);
      if (kingNotifTimerRef.current) clearTimeout(kingNotifTimerRef.current);
      setKingNotifKey((k) => k + 1);
      setShowKingNotif(true);
      kingNotifTimerRef.current = setTimeout(() => {
        setShowKingNotif(false);
        kingNotifTimerRef.current = null;
      }, 1200);
    }
    lastScoreRef.current = score;
  }, [displayGame?.players, displayGame?.isActive, myPlayerId, displayGame?.playersCount]);

  useEffect(() => {
    const isActive = displayGame?.isActive;
    if (isActive === undefined || isActive === null) return;

    if (isActive === true) {
      const activeGameId = Number(displayGame?.currentGameId ?? Number.NaN);
      if (Number.isFinite(activeGameId)) {
        seenActiveGameIdsRef.current.add(activeGameId);
      }
    }

    if (prevIsActiveRef.current === true && isActive === false) {
      if (kingNotifTimerRef.current) {
        clearTimeout(kingNotifTimerRef.current);
        kingNotifTimerRef.current = null;
      }
      if (powerupNotifTimerRef.current) {
        clearTimeout(powerupNotifTimerRef.current);
        powerupNotifTimerRef.current = null;
      }
      setShowKingNotif(false);
      setShowPowerupAcquired(false);
      setEndedGamePlayers(displayGame?.players ?? []);
      setEndedGamePlayerCount(displayGame?.playersCount ?? 0);
      const endedGameId = Number(displayGame?.currentGameId ?? Number.NaN);
      if (Number.isFinite(endedGameId)) {
        lastShownGameOverGameIdRef.current = endedGameId;
      }
      setShowGameOverModal(true);
    }
    prevIsActiveRef.current = isActive;
  }, [displayGame]);

  useEffect(() => {
    if (showGameOverModal) return;
    const ended = settlement;
    if (!ended) return;
    if (ended.isActive !== false) return;
    const endedGameId = Number(ended.currentGameId ?? Number.NaN);
    if (!Number.isFinite(endedGameId)) return;
    const completedAtMs = Date.parse(ended.completedAtIso ?? "");
    const isRecentCompletion =
      Number.isFinite(completedAtMs) && Date.now() - completedAtMs <= 5 * 60_000;
    const sawGameActiveInThisTab = seenActiveGameIdsRef.current.has(endedGameId);
    if (!sawGameActiveInThisTab && !isRecentCompletion) return;
    if (lastShownGameOverGameIdRef.current === endedGameId) return;

    setEndedGamePlayers(ended.players ?? []);
    setEndedGamePlayerCount(ended.playersCount ?? 0);
    lastShownGameOverGameIdRef.current = endedGameId;
    setShowGameOverModal(true);
  }, [settlement, showGameOverModal]);

  const closeGameOverModal = useCallback(() => {
    setShowGameOverModal(false);
  }, []);

  useEffect(() => {
    if (showGameOverModal) return;
    const ended = settlement;
    if (!ended) return;
    const endedGameId = Number(ended.currentGameId ?? Number.NaN);
    if (!Number.isFinite(endedGameId)) return;
    if (transferAnimShownGameIdsRef.current.has(endedGameId)) return;

    const rewardTxSent = !!ended.txTrace?.rewardTxHash;
    const players = (ended.players ?? []).slice(0, ended.playersCount ?? 0);
    const hasAnyPayout = players.some((p) => Number(p.score) > 0);
    if (!rewardTxSent || !hasAnyPayout) return;

    transferAnimShownGameIdsRef.current.add(endedGameId);
    setShowTransferAnim(true);
    const timer = setTimeout(() => setShowTransferAnim(false), 4500);
    return () => clearTimeout(timer);
  }, [settlement, showGameOverModal]);

  useEffect(() => {
    const players = displayGame?.players?.slice(0, displayGame?.playersCount ?? 0) ?? [];
    if (!players.length || !displayGame?.isActive) {
      prevPlayerPositionsRef.current = null;
      return;
    }

    const nextMap = new Map<number, number>();
    for (const p of players) nextMap.set(p.id, p.currentPosition);

    const prevMap = prevPlayerPositionsRef.current;
    if (!prevMap) {
      prevPlayerPositionsRef.current = nextMap;
      return;
    }

    let movedCount = 0;
    for (const p of players) {
      const prevPos = prevMap.get(p.id);
      if (prevPos !== undefined && prevPos !== p.currentPosition) {
        movedCount += 1;
      }
    }

    let hadBump = false;
    const prevPosToPlayer = new Map<number, number>();
    prevMap.forEach((pos, id) => {
      prevPosToPlayer.set(pos, id);
    });

    for (const p of players) {
      const prevPos = prevMap.get(p.id);
      if (prevPos === undefined || prevPos === p.currentPosition) continue;
      const displacedPlayerId = prevPosToPlayer.get(p.currentPosition);
      if (!displacedPlayerId || displacedPlayerId === p.id) continue;
      const displacedPrevPos = prevMap.get(displacedPlayerId);
      const displacedCurrPos = nextMap.get(displacedPlayerId);
      if (
        displacedPrevPos !== undefined &&
        displacedCurrPos !== undefined &&
        displacedCurrPos !== displacedPrevPos
      ) {
        hadBump = true;
        break;
      }
    }

    const blips = Math.min(movedCount, 3);
    for (let i = 0; i < blips; i += 1) {
      window.setTimeout(() => playMoveSound(), i * 90);
    }
    if (hadBump) playBumpSound();

    prevPlayerPositionsRef.current = nextMap;
  }, [displayGame?.players, displayGame?.playersCount, displayGame?.isActive, playMoveSound, playBumpSound]);

  useEffect(() => {
    const players = displayGame?.players?.slice(0, displayGame?.playersCount ?? 0) ?? [];
    if (!players.length || !displayGame?.isActive) {
      prevPlayerScoresRef.current = null;
      kingStreakRef.current = new Map();
      return;
    }

    const nextScores = new Map<number, number>();
    for (const p of players) nextScores.set(p.id, Number(p.score));

    const prevScores = prevPlayerScoresRef.current;
    if (!prevScores) {
      prevPlayerScoresRef.current = nextScores;
      return;
    }

    const newStreaks = new Map<number, number>();
    for (const p of players) {
      const prev = prevScores.get(p.id);
      const curr = Number(p.score);
      if (prev === undefined || curr <= prev) continue;

      const delta = curr - prev;
      const oldStreak = kingStreakRef.current.get(p.id) ?? 0;
      const streak = oldStreak + delta;
      newStreaks.set(p.id, streak);

      const hits = Math.min(delta, 3);
      for (let i = 0; i < hits; i += 1) {
        const level = Math.min(streak - (hits - 1 - i), 10);
        window.setTimeout(() => playKingPower(level), i * 120);
      }
    }

    kingStreakRef.current = newStreaks;
    prevPlayerScoresRef.current = nextScores;
  }, [displayGame?.players, displayGame?.playersCount, displayGame?.isActive, playKingPower]);

  useEffect(() => {
    const players = displayGame?.players?.slice(0, displayGame?.playersCount ?? 0) ?? [];
    if (!players.length || !displayGame?.isActive || !myPlayerId) {
      prevPowerupScoresRef.current = null;
      if (powerupNotifTimerRef.current) {
        clearTimeout(powerupNotifTimerRef.current);
        powerupNotifTimerRef.current = null;
      }
      setShowPowerupAcquired(false);
      return;
    }

    const nextMap = new Map<number, number>();
    for (const p of players) nextMap.set(p.id, Number(p.powerupScore ?? 0));

    const prevMap = prevPowerupScoresRef.current;
    prevPowerupScoresRef.current = nextMap;
    if (!prevMap) return;

    const prev = prevMap.get(myPlayerId) ?? 0;
    const curr = nextMap.get(myPlayerId) ?? 0;
    if (prev === 0 && curr > 0) {
      if (kingNotifTimerRef.current) {
        clearTimeout(kingNotifTimerRef.current);
        kingNotifTimerRef.current = null;
      }
      setShowKingNotif(false);
      if (powerupNotifTimerRef.current) clearTimeout(powerupNotifTimerRef.current);
      setPowerupAcquiredKey((k) => k + 1);
      setShowPowerupAcquired(true);
      powerupNotifTimerRef.current = setTimeout(() => {
        setShowPowerupAcquired(false);
        powerupNotifTimerRef.current = null;
      }, 2500);
    }
  }, [displayGame?.players, displayGame?.playersCount, displayGame?.isActive, myPlayerId]);

  useEffect(() => {
    const players = displayGame?.players?.slice(0, displayGame?.playersCount ?? 0) ?? [];
    if (!players.length || !displayGame?.isActive) {
      prevPowerupScoresForLaserRef.current = null;
      return;
    }

    const nextMap = new Map<number, number>();
    for (const p of players) nextMap.set(p.id, Number(p.powerupScore ?? 0));

    const prevMap = prevPowerupScoresForLaserRef.current;
    prevPowerupScoresForLaserRef.current = nextMap;
    if (!prevMap) return;

    let laserFires = 0;
    for (const p of players) {
      if (myPlayerId && p.id === myPlayerId) continue;
      const prev = prevMap.get(p.id) ?? 0;
      const curr = nextMap.get(p.id) ?? 0;
      if (curr < prev) laserFires += prev - curr;
    }

    const zaps = Math.min(laserFires, 3);
    for (let i = 0; i < zaps; i += 1) {
      window.setTimeout(() => playLaserSound(), i * 90);
    }
  }, [displayGame?.players, displayGame?.playersCount, displayGame?.isActive, myPlayerId, playLaserSound]);

  useEffect(() => {
    const flat = displayGame?.board ? displayGame.board.flat() : null;
    if (!flat || !myPlayerId || !displayGame?.isActive) {
      prevFlatBoardRef.current = flat;
      return;
    }

    const prev = prevFlatBoardRef.current;
    prevFlatBoardRef.current = flat;
    if (!prev) return;

    const myNewPos = flat.indexOf(myPlayerId);
    if (myNewPos >= 0 && prev[myNewPos] === BOMB_MARK) {
      setBombAnimKey((k) => k + 1);
      setShowBombAnim(true);
      playBombSound();
      const t = setTimeout(() => setShowBombAnim(false), 1800);
      return () => clearTimeout(t);
    }
  }, [displayGame?.board, displayGame?.isActive, myPlayerId, playBombSound]);

  useEffect(() => {
    return () => {
      if (kingNotifTimerRef.current) clearTimeout(kingNotifTimerRef.current);
      if (powerupNotifTimerRef.current) clearTimeout(powerupNotifTimerRef.current);
    };
  }, []);

  const findModeGames = useCallback(
    (mode: GameMode, games: ActiveGameSummary[]) =>
      games
        .filter(
          (g) =>
            Number(g.boardSideLen) === mode.boardSideLen &&
            Number(g.maxPlayers) === mode.maxPlayers
        )
        .sort((a, b) => {
          const activeA = a.isActive ? 1 : 0;
          const activeB = b.isActive ? 1 : 0;
          if (activeA !== activeB) return activeB - activeA;
          return Number(b.gameId) - Number(a.gameId);
        }),
    []
  );

  const fetchGamesOverview = useCallback(async (): Promise<ActiveGameSummary[]> => {
    try {
      const res = await fetch(`${RELAYER_URL}/games`);
      const data: GamesOverviewResponse = await res.json();
      if (!res.ok || data?.ok === false) return [];
      const games: ActiveGameSummary[] = Array.isArray(data?.activeGames)
        ? data.activeGames
        : [];
      const completedByMode = extractCompletedByMode(data);
      setActiveGames(games);
      setLastCompletedByMode((prev) => mergeCompletedByMode(prev, completedByMode));
      return games;
    } catch {
      return [];
    }
  }, []);

  const resolveGameIdForMode = useCallback(
    async (mode: GameMode): Promise<number | null> => {
      const localMatches = findModeGames(mode, activeGames);
      const modeLookupKey = modeKeyFromMode(mode);
      if (localMatches.length > 0) {
        return Number(localMatches[0].gameId);
      }
      const localCompleted = lastCompletedByMode[modeLookupKey];
      if (localCompleted) {
        return Number(localCompleted.currentGameId);
      }
      try {
        const res = await fetch(`${RELAYER_URL}/games`);
        const data: GamesOverviewResponse = await res.json();
        if (!res.ok || data?.ok === false) return null;
        const nextActiveGames: ActiveGameSummary[] = Array.isArray(data?.activeGames)
          ? data.activeGames
          : [];
        const completedByMode = extractCompletedByMode(data);
        setActiveGames(nextActiveGames);
        setLastCompletedByMode((prev) => mergeCompletedByMode(prev, completedByMode));
        const matches = findModeGames(mode, nextActiveGames);
        if (matches.length > 0) return Number(matches[0].gameId);
        const remoteCompleted = completedByMode[modeLookupKey];
        return remoteCompleted ? Number(remoteCompleted.currentGameId) : null;
      } catch {
        return null;
      }
    },
    [activeGames, findModeGames, lastCompletedByMode]
  );

  const refetchGameStatus = useCallback(async () => {
    if (!selectedMode) return;
    const resolvedGameId = await resolveGameIdForMode(selectedMode);
    const gameIdToQuery = resolvedGameId ?? selectedGameId;
    if (gameIdToQuery == null) {
      setGameStatus(null);
      setError(`No active ${selectedMode.label} game right now.`);
      return;
    }
    if (selectedGameId !== gameIdToQuery) setSelectedGameId(gameIdToQuery);
    try {
      const res = await fetch(`${RELAYER_URL}/game-status?gameId=${gameIdToQuery}`);
      const data: GameStatus & { error?: string } = await res.json();
      if (res.ok && data.ok !== false) {
        setGameStatus(data);
        setError(null);
      } else {
        setError(data.error ?? "Game status unavailable");
      }
    } catch {
      setError("Cannot reach relayer at " + RELAYER_URL);
    }
  }, [resolveGameIdForMode, selectedGameId, selectedMode]);

  const fetchLeaderboard = useCallback(async () => {
    try {
      const res = await fetch(`${RELAYER_URL}/leaderboard`);
      const data = await res.json();
      if (res.ok && data.ok !== false) {
        setLeaderboard(Array.isArray(data.leaderboard) ? data.leaderboard : []);
        setLeaderboardError(null);
      } else {
        setLeaderboardError(data.error ?? "Leaderboard unavailable");
      }
    } catch {
      setLeaderboardError("Cannot reach relayer leaderboard endpoint");
    } finally {
      setLeaderboardLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedMode) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastKnownIsActive: boolean | undefined = undefined;
    const scheduleNextPoll = (hadError: boolean) => {
      const baseDelayMs = lastKnownIsActive ? 1_000 : 2_500;
      const delayMs = hadError ? Math.min(baseDelayMs * 2, 8_000) : baseDelayMs;
      timer = setTimeout(() => {
        void poll();
      }, delayMs);
    };
    const poll = async () => {
      let hadError = false;
      try {
        const resolvedGameId = await resolveGameIdForMode(selectedMode);
        const gameIdToQuery = resolvedGameId ?? selectedGameId;
        if (gameIdToQuery == null) {
          if (active) {
            setGameStatus(null);
            setError(`No active ${selectedMode.label} game right now.`);
          }
          lastKnownIsActive = false;
          if (active) scheduleNextPoll(false);
          return;
        }
        if (active && selectedGameId !== gameIdToQuery) setSelectedGameId(gameIdToQuery);
        const res = await fetch(`${RELAYER_URL}/game-status?gameId=${gameIdToQuery}`);
        const data: GameStatus & { error?: string } = await res.json();
        if (active) {
          if (res.ok && data.ok !== false) {
            setGameStatus(data);
            setError(null);
            lastKnownIsActive = !!data.isActive;
          } else {
            hadError = true;
            setError(data.error ?? "Game status unavailable");
          }
        }
      } catch {
        hadError = true;
        if (active) setError("Cannot reach relayer at " + RELAYER_URL);
      }
      if (active) scheduleNextPoll(hadError);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [resolveGameIdForMode, selectedGameId, selectedMode]);

  useEffect(() => {
    let active = true;
    const pollLeaderboard = async () => {
      if (!active) return;
      await fetchLeaderboard();
    };
    pollLeaderboard();
    const id = setInterval(pollLeaderboard, 10_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [fetchLeaderboard]);

  useEffect(() => {
    let active = true;
    const pollGames = async () => {
      if (!active) return;
      await fetchGamesOverview();
    };
    pollGames();
    const id = setInterval(pollGames, 5_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [fetchGamesOverview]);

  useEffect(() => {
    if (!gameStatus?.isActive || !gameStatus.gameEndTimestamp) {
      setCountdown(0);
      return;
    }
    const tick = () => {
      const rem = Math.max(
        0,
        gameStatus.gameEndTimestamp! - Math.floor(Date.now() / 1000)
      );
      setCountdown(rem);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [gameStatus?.isActive, gameStatus?.gameEndTimestamp]);

  useEffect(() => {
    if (!gameStatus?.isActive) return;
    if (countdown <= 10 && countdown > 0) {
      playEmergencyTick();
    }
  }, [countdown, gameStatus?.isActive, playEmergencyTick]);

  const gameId = gameStatus?.currentGameId ?? selectedGameId ?? GAME_ID;
  const boardPDA = useMemo(() => getBoardPDA(gameId), [gameId]);

  const registerForGame = useCallback(async () => {
    if (!sessionKeypair || !sessionFunded || registerPending) return;
    if (gameStatus?.currentGameId == null) {
      addLog("No game to join. Start a session from the relayer first.");
      return;
    }
    if (gameStatus?.isActive) {
      addLog("Game already started.");
      return;
    }
    if (myPlayerId) {
      addLog("You are already registered.");
      return;
    }
    if ((gameStatus?.playersCount ?? 0) >= maxPlayers) {
      addLog("Game is full.");
      return;
    }
    setRegisterPending(true);
    try {
      const ix = buildRegisterPlayerIx(sessionKeypair.publicKey, boardPDA, gameId);
      const tx = new Transaction().add(ix);
      const { blockhash } = await devnetConnection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = sessionKeypair.publicKey;
      tx.sign(sessionKeypair);
      const sig = await devnetConnection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });
      addLog(`Registered! Tx: ${sig.slice(0, 12)}...`);
    } catch (e: any) {
      const msg = e?.message?.slice(0, 80) || "Unknown error";
      addLog(`Register failed: ${msg}`);
    }
    setRegisterPending(false);
  }, [sessionKeypair, sessionFunded, boardPDA, gameId, registerPending, gameStatus, myPlayerId, maxPlayers, devnetConnection, addLog]);

  const makeMove = useCallback(
    (movePosition: number) => {
      if (!sessionKeypair || !myPlayerId) return;
      if (!gameStatus?.isActive) return;

      const now = Date.now();
      if (now - moveDebounceRef.current < 120) return;
      moveDebounceRef.current = now;

      const base = optimisticBoardRef.current
        ?? (gameStatus.board ? gameStatus.board.flat() : null);
      if (base) {
        lastOptimisticMoveRef.current = now;
        const board = [...base];
        const currentPos = board.indexOf(myPlayerId);
        if (currentPos >= 0) {
          const raw = currentPos + movePosition;
          const newPos = ((raw % boardSize) + boardSize) % boardSize;
          const target = board[newPos];

          if (target === BOMB_MARK) {
            setBombAnimKey((k) => k + 1);
            setShowBombAnim(true);
            window.setTimeout(() => setShowBombAnim(false), 1800);
            playBombSound();
            board[currentPos] = EMPTY;
            board[newPos] = EMPTY;
            let landing = Math.max(0, myPlayerId - 1);
            for (let i = 0; i < boardSize; i += 1) {
              if (board[landing] === EMPTY) break;
              landing = (landing + 1) % boardSize;
            }
            board[landing] = myPlayerId;
            addLog("💣 Bomb hit! Warped to start.");
          } else if (target === EMPTY || target === KING_MARK || target === POWERUP_MARK) {
            board[currentPos] = EMPTY;
            board[newPos] = myPlayerId;
          } else if (target >= 1 && target <= maxPlayers && target !== myPlayerId) {
            const pushPos = ((newPos + movePosition + movePosition) % boardSize + boardSize) % boardSize;
            board[pushPos] = target;
            board[currentPos] = EMPTY;
            board[newPos] = myPlayerId;
            playBumpSound();
          }

          optimisticBoardRef.current = board;
          setOptimisticBoard(board);
        }
      }

      (async () => {
        try {
          const directionVariant =
            movePosition === -boardSideLen
              ? 0
              : movePosition === boardSideLen
                ? 1
                : movePosition === -1
                  ? 2
                  : movePosition === 1
                    ? 3
                    : null;
          if (directionVariant == null) {
            addLog(`Move failed: invalid direction ${movePosition}`);
            return;
          }

          const ix = buildMakeMoveIx(
            sessionKeypair.publicKey,
            boardPDA,
            gameId,
            myPlayerId,
            directionVariant
          );
          const memoIx = new TransactionInstruction({
            programId: MEMO_PROGRAM_ID,
            keys: [],
            data: Buffer.from(`move:${Date.now()}:${movePosition}`),
          });
          const tx = new Transaction().add(ix, memoIx);

          let blockhash: string;
          const cached = cachedBlockhashRef.current;
          if (cached && Date.now() - cached.fetchedAt < 30_000) {
            blockhash = cached.blockhash;
          } else {
            const fresh = await erConnection.getLatestBlockhash();
            blockhash = fresh.blockhash;
            cachedBlockhashRef.current = { blockhash, fetchedAt: Date.now() };
          }

          tx.recentBlockhash = blockhash;
          tx.feePayer = sessionKeypair.publicKey;
          tx.sign(sessionKeypair);
          const sig = await erConnection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
          });

          addLog(`Moved ${moveLabel(movePosition)} (${sig.slice(0, 8)}...)`);
        } catch (e: any) {
          optimisticBoardRef.current = null;
          setOptimisticBoard(null);
          const msg = e?.message?.slice(0, 220) || "Unknown error";
          addLog(`Move failed: ${msg}`);
        }
      })();
    },
    [sessionKeypair, myPlayerId, gameStatus?.isActive, gameStatus?.board, boardPDA, gameId, boardSize, maxPlayers, erConnection, addLog, playBumpSound, playBombSound]
  );

  const usePower = useCallback(
    (direction: number) => {
      if (!myPlayerId || !gameStatus?.isActive) return;
      if (myPowerupScore <= 0) {
        addLog("No power charged. Step on ⚡ to acquire.");
        return;
      }

      playLaserSound();
      const currentBoard = optimisticBoardRef.current
        ?? (gameStatus?.board ? gameStatus.board.flat() : null);
      if (currentBoard) {
        const myPos = currentBoard.indexOf(myPlayerId);
        if (myPos >= 0) {
          const beam = getBeamCells(
            myPos,
            direction,
            currentBoard,
            boardSize,
            boardSideLen,
            maxPlayers
          );
          if (beam.length > 0) {
            if (powerBeamTimerRef.current) clearTimeout(powerBeamTimerRef.current);
            setPowerBeam(beam);
            powerBeamTimerRef.current = setTimeout(() => setPowerBeam(null), 700);
          }
        }
      }

      (async () => {
        try {
          const res = await fetch(`${RELAYER_URL}/use-power`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playerId: myPlayerId, direction, gameId }),
          });
          const data = await res.json();
          if (data.ok) {
            addLog(`⚡ Power fired ${moveLabel(direction)}! (${(data.txHash as string)?.slice(0, 8)}...)`);
          } else {
            addLog(`Power failed: ${(data.error as string)?.slice(0, 60)}`);
          }
        } catch (e: any) {
          addLog(`Power failed: ${e?.message?.slice(0, 60) ?? "error"}`);
        }
      })();
    },
    [myPlayerId, myPowerupScore, gameStatus?.isActive, gameStatus?.board, gameId, boardSize, boardSideLen, maxPlayers, addLog, playLaserSound]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      let move: number | null = null;
      switch (e.key) {
        case "w": case "W": move = -boardSideLen; break;
        case "s": case "S": move = boardSideLen; break;
        case "a": case "A": move = -1; break;
        case "d": case "D": move = 1; break;
      }
      if (move !== null) {
        e.preventDefault();
        makeMove(move);
        return;
      }

      let powerDir: number | null = null;
      switch (e.key) {
        case "ArrowUp":    powerDir = -boardSideLen; break;
        case "ArrowDown":  powerDir = boardSideLen; break;
        case "ArrowLeft":  powerDir = -1; break;
        case "ArrowRight": powerDir = 1; break;
      }
      if (powerDir !== null) {
        e.preventDefault();
        usePower(powerDir);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [boardSideLen, makeMove, usePower]);

  const flatBoard = useMemo(() => {
    if (optimisticBoard) return optimisticBoard;
    if (!displayGame?.board) return new Array(boardSize).fill(0);
    return displayGame.board.flat();
  }, [displayGame?.board, optimisticBoard, boardSize]);

  const kingTileIndexFromBoard = useMemo(() => {
    const idx = flatBoard.indexOf(KING_MARK);
    return idx >= 0 ? idx : null;
  }, [flatBoard]);

  useEffect(() => {
    if (kingTileIndexFromBoard != null) {
      kingTileIndexRef.current = kingTileIndexFromBoard;
    }
  }, [kingTileIndexFromBoard]);

  const kingTileIndex = kingTileIndexFromBoard ?? kingTileIndexRef.current;

  const statusText = displayGame?.isActive
    ? "ACTIVE"
    : gameStatus?.currentGameId !== null
    ? `Waiting (${displayGame?.playersCount ?? 0}/${maxPlayers} players)`
    : displayGame
    ? `Completed (Game ${displayGame.currentGameId})`
    : "No game";

  const shortWallet = useCallback((wallet: string) => {
    if (!wallet) return "-";
    return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  }, []);

  return (
    <div className="app">
      <BackgroundMusic />
      {!showLanding && (
        <button type="button" className="btn-back btn-back-corner" onClick={backToLanding}>
          Back
        </button>
      )}
      <header className="header">
        <h1 className="title">
          <span className="crown">👑</span> King Tiles
        </h1>
        <div className="header-right">
          {gameStatus?.isActive && (
            <div className={`timer ${countdown <= 10 ? "warning" : ""}`}>
              ⏱ {formatTime(countdown)}
            </div>
          )}
          <WalletMultiButton />
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {showKingNotif && (
        <div key={kingNotifKey} className="king-notification">
          👑 +1 score! You're on the king!
        </div>
      )}

      {showPowerupAcquired && (
        <div key={powerupAcquiredKey} className="powerup-acquired-notification">
          ⚡ Power charged! Use Arrow Keys to fire!
        </div>
      )}

      {showBombAnim && (
        <div key={bombAnimKey} className="bomb-explosion-overlay" aria-hidden="true">
          <div className="bomb-explosion-emoji">💥</div>
          <div className="bomb-explosion-text">💥 BOOM! Warped back to start!</div>
        </div>
      )}

      {showTransferAnim && (
        <div className="transfer-overlay" aria-hidden="true">
          {COIN_X_POSITIONS.map((x, i) => (
            <div
              key={i}
              className="coin-particle"
              style={
                {
                  "--delay": `${(i * 0.22).toFixed(2)}s`,
                  "--x": `${x}%`,
                } as React.CSSProperties
              }
            >
              ◎
            </div>
          ))}
          <div className="transfer-message">
            💸 Payout sent!
          </div>
        </div>
      )}

      {showGameOverModal && (() => {
        const players = endedGamePlayers.slice(0, endedGamePlayerCount);
        const sorted = [...players].sort(
          (a, b) => Number(b.score) - Number(a.score)
        );
        const winnerId = getWinningPlayerId(sorted);
        const winner = winnerId
          ? sorted.find((p) => p.id === winnerId) ?? null
          : null;
        const isMyWin = winnerId != null && myPlayerId === winnerId;
        const payoutTxSent = !!settlement?.txTrace?.rewardTxHash;
        const hasAnyPayout = players.some((p) => Number(p.score) > 0);
        return (
          <div
            className="game-over-overlay"
            onClick={closeGameOverModal}
          >
            <div
              className="game-over-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="game-over-header">
                <span className="game-over-icon">🏆</span>
                <h2>Game Over!</h2>
              </div>
              {winner && (
                <div
                  className={`winner-announcement ${isMyWin ? "my-win" : ""}`}
                >
                  {isMyWin
                    ? "🎉 You Win! Congrats!"
                    : `👑 ${PLAYER_LABELS[winner.id - 1] ?? `P${winner.id}`} Wins!`}
                </div>
              )}
              {!winner && (
                <div className="winner-announcement">
                  🤝 Draw game! No single winner.
                </div>
              )}
              {hasAnyPayout && (
                <div className="status-row" style={{ marginBottom: 8 }}>
                  <span className="label">Payout:</span>
                  <span className="value">
                    {payoutTxSent ? "Sent on-chain ✅" : "Pending/processing..."}
                  </span>
                </div>
              )}
              <div className="final-scores-modal">
                {sorted.map((p, i) => (
                  <div
                    key={i}
                    className={`final-row-modal ${p.id === myPlayerId ? "me" : ""}`}
                  >
                    <span className="final-rank">
                      {i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"}
                    </span>
                    <span style={{ color: PLAYER_COLORS[(p.id - 1) % PLAYER_COLORS.length] }}>
                      {PLAYER_LABELS[p.id - 1] ?? `P${p.id}`}
                    </span>
                    <span className="final-score-modal">{p.score} pts</span>
                  </div>
                ))}
              </div>
              <button
                className="btn-dismiss"
                onClick={closeGameOverModal}
              >
                Close
              </button>
            </div>
          </div>
        );
      })()}

      {showLanding ? (
        <div className="landing-shell">
          <div className="landing-content">
            <h2 className="landing-title">Play For The Crown</h2>
            <p className="landing-subtitle">
              Join King Tiles, hold the king tile, and earn on-chain rewards.
            </p>
            <div className="mode-select-box">
              <div className="mode-select-title">Choose Your Arena</div>
              <div className="mode-select-grid">
                {GAME_MODES.map((mode) => (
                  (() => {
                    const modeGames = findModeGames(mode, activeGames);
                    const currentGame = modeGames.length > 0 ? modeGames[0] : null;
                    const endedForMode = lastCompletedByMode[modeKeyFromMode(mode)] ?? null;

                    const gameIdLabel = currentGame
                      ? String(currentGame.gameId)
                      : endedForMode
                        ? String(endedForMode.currentGameId)
                        : "-";

                    const statusLabel = currentGame
                      ? currentGame.isActive
                        ? "Game Started"
                        : "Waiting for players to join..."
                      : endedForMode
                        ? "Game Ended"
                        : "Game not started";
                    const statusClass = currentGame
                      ? currentGame.isActive
                        ? "started"
                        : "waiting"
                      : endedForMode
                        ? "ended"
                        : "waiting";

                    return (
                      <button
                        key={mode.label}
                        type="button"
                        className={`mode-card mode-card-${statusClass}`}
                        onClick={async () => {
                          setSelectedMode(mode);
                          setSelectedGameId(null);
                          const resolvedGameId = await resolveGameIdForMode(mode);
                          if (resolvedGameId != null) {
                            setSelectedGameId(resolvedGameId);
                          }
                          setShowLanding(false);
                        }}
                      >
                        <span className="mode-card-top">
                          <span className="mode-card-title">{mode.label}</span>
                          <span className="mode-card-id">ID {gameIdLabel}</span>
                        </span>
                        <span className="mode-card-sub">
                          Fee: {(mode.registrationFeeLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL
                        </span>
                        <span className={`mode-card-status ${statusClass}`}>{statusLabel}</span>
                      </button>
                    );
                  })()
                ))}
              </div>
            </div>
          </div>

          <aside className="landing-leaderboard">
            <h3>Leaderboard – Top 5</h3>
            {leaderboardLoading && <div className="landing-leaderboard-empty">Loading...</div>}
            {!leaderboardLoading && leaderboardError && (
              <div className="landing-leaderboard-empty">{leaderboardError}</div>
            )}
            {!leaderboardLoading && !leaderboardError && (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Wallet</th>
                    <th>Best</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.length === 0 && (
                    <tr>
                      <td colSpan={3} className="landing-leaderboard-empty-cell">
                        No scores yet
                      </td>
                    </tr>
                  )}
                  {leaderboard.map((row, idx) => (
                    <tr key={row.wallet}>
                      <td>{idx + 1}</td>
                      <td className="mono">{shortWallet(row.wallet)}</td>
                      <td>{row.best_score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </aside>
        </div>
      ) : (
        <>
      {publicKey && (
        <div className="identity-bar">
          <span className="label">Wallet:</span>
          <span className="mono">{publicKey.toBase58().slice(0, 20)}...</span>
          {myPlayerId ? (
            <span
              className="badge"
              style={{ background: PLAYER_COLORS[(myPlayerId - 1) % PLAYER_COLORS.length] }}
            >
              Player {myPlayerId} · Score: {myScore}
            </span>
          ) : displayGame?.currentGameId == null ? (
            <span className="badge inactive">Game not started</span>
          ) : displayGame?.isActive === false && Number(displayGame?.gameEndTimestamp ?? 0) > 0 ? (
            <span className="badge inactive">Game ended</span>
          ) : (
            <span className="badge inactive">Not registered</span>
          )}
          {publicKey && gameStatus?.currentGameId != null && !gameStatus?.isActive && !myPlayerId && (gameStatus?.playersCount ?? 0) < maxPlayers && (
            <button
              type="button"
              className="btn-register"
              onClick={registerForGame}
              disabled={registerPending || !sessionFunded}
            >
              {!sessionFunded
                ? "Funding session…"
                : registerPending
                  ? "Registering…"
                  : `Register (${(registrationFeeLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL)`}
            </button>
          )}
        </div>
      )}

      <div className="main-layout">
        <div className="side-panel">
          <div className="panel-section">
            <h3>Status</h3>
            <div className="status-row">
              <span className="label">Game:</span>
              <span className={`value ${gameStatus?.isActive ? "active" : ""}`}>
                {statusText}
              </span>
            </div>
            <div className="status-row">
              <span className="label">Source:</span>
              <span className="value">{displayGame?.source ?? "N/A"}</span>
            </div>
            {displayGame?.isActive && (
              <div className="status-row">
                <span className="label">Time Left:</span>
                <span
                  className={`value ${countdown <= 10 ? "text-warning" : ""}`}
                >
                  {formatTime(countdown)}
                </span>
              </div>
            )}
          </div>

          {settlement && (
            <div className="panel-section">
              <h3>Settlement Details</h3>
              <div className="status-row">
                <span className="label">Current Game ID:</span>
                <span className="value">{settlement.currentGameId}</span>
              </div>
              {settlement.txTrace.rewardTxSolscanUrl ? (
                <div className="status-row">
                  <span className="label">Payout Tx:</span>
                  <a
                    className="value mono"
                    href={settlement.txTrace.rewardTxSolscanUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Solscan link
                  </a>
                </div>
              ) : settlement.txTrace.rewardTxHash ? (
                <div className="status-row">
                  <span className="label">Payout Tx:</span>
                  <span className="value mono">
                    {settlement.txTrace.rewardTxHash.slice(0, 10)}... (confirmed)
                  </span>
                </div>
              ) : (
                <div className="status-row">
                  <span className="label">Payout Tx:</span>
                  <span className="value">
                    {settlement.txTrace.rewardError
                      ? "Failed (see relayer logs)"
                      : "Pending confirmation"}
                  </span>
                </div>
              )}
              {settlement.txTrace.startSessionTxHash && (
                <div className="status-row">
                  <span className="label">Start Tx:</span>
                  <span className="value mono">
                    {settlement.txTrace.startSessionTxHash.slice(0, 10)}...
                  </span>
                </div>
              )}
              {settlement.txTrace.delegateBoardTxHash && (
                <div className="status-row">
                  <span className="label">Delegate Tx:</span>
                  <span className="value mono">
                    {settlement.txTrace.delegateBoardTxHash.slice(0, 10)}...
                  </span>
                </div>
              )}
            </div>
          )}

          <div className="panel-section">
            <h3>Players</h3>
            {displayGame?.players
              ?.slice(0, displayGame?.playersCount ?? 0)
              ?.map((p, i) => (
              <div
                key={i}
                className={`player-card ${
                  myPlayerId === p.id ? "me" : ""
                }`}
                style={{ borderLeftColor: PLAYER_COLORS[i % PLAYER_COLORS.length] }}
              >
                <div className="player-top">
                  <span
                    className="player-label"
                    style={{ color: PLAYER_COLORS[i % PLAYER_COLORS.length] }}
                  >
                    {PLAYER_LABELS[i] ?? `P${p.id}`}
                    {Number(p.powerupScore ?? 0) > 0 && (
                      <span className="player-power-badge" title="Power charged!"> ⚡</span>
                    )}
                  </span>
                  <span className="player-score">
                    Score: <b>{p.score}</b>
                  </span>
                </div>
                <div className="player-addr mono">{p.player.slice(0, 20)}...</div>
              </div>
            ))}
          </div>

          <div className="panel-section">
            <h3>Game Logs</h3>
            <div className="logs">
              {logs.length === 0 && (
                <div className="log-empty">No logs yet</div>
              )}
              {logs.map((l, i) => (
                <div key={i} className="log-entry">
                  {l}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="board-area">
          <div className="grid-wrapper">
            <div
              className="grid"
              style={{ gridTemplateColumns: `repeat(${boardSideLen}, 1fr)` }}
            >
              {flatBoard.map((cell, idx) => {
                let cls = "cell";
                let content: React.ReactNode = null;
                let inlineStyle: React.CSSProperties | undefined;

                const isPlayer = cell >= 1 && cell <= maxPlayers;
                const isKingTile = kingTileIndex != null && idx === kingTileIndex;
                const isPowerupTile = cell === POWERUP_MARK;
                const isBombTile = cell === BOMB_MARK;
                const beamIdx = powerBeam ? powerBeam.indexOf(idx) : -1;
                const isBeamCell = beamIdx >= 0;
                const isBeamHit = isBeamCell && powerBeam != null && beamIdx === powerBeam.length - 1 && isPlayer;

                if (isPlayer) {
                  cls += ` player-cell p${cell}`;
                  if (myPlayerId === cell) cls += " me";
                  if (isKingTile) cls += " king-occupied";
                  if (isBeamHit) cls += " beam-hit";
                  if (cell > 4) {
                    const color = PLAYER_COLORS[(cell - 1) % PLAYER_COLORS.length];
                    inlineStyle = {
                      background: `${color}40`,
                      borderColor: color,
                      color,
                    };
                  }
                  content = (
                    <>
                      {isKingTile && <span className="cell-king-corner">👑</span>}
                      {PLAYER_LABELS[cell - 1] ?? `P${cell}`}
                    </>
                  );
                } else if (cell === KING_MARK) {
                  cls += " king";
                  if (isBeamCell) cls += " laser-beam";
                  content = "👑";
                } else if (isKingTile) {
                  cls += " king";
                  content = "👑";
                } else if (isPowerupTile) {
                  cls += " powerup";
                  content = "⚡";
                } else if (isBombTile) {
                  cls += " bomb";
                  content = "💣";
                } else if (isBeamCell) {
                  cls += " laser-beam";
                }

                return (
                  <div
                    key={idx}
                    className={cls}
                    style={
                      isBeamCell
                        ? ({ ...(inlineStyle ?? {}), "--beam-idx": beamIdx } as React.CSSProperties)
                        : inlineStyle
                    }
                  >
                    {content}
                  </div>
                );
              })}
            </div>
          </div>

          {gameStatus?.isActive && myPlayerId && (
            <div className="controls">
              <p className="controls-hint">
                <b>WASD</b> = Move &nbsp;|&nbsp; <b>Arrow Keys</b> = Fire Power ⚡
              </p>

              <div className="power-bar-row">
                <span className="power-bar-label">⚡ Power</span>
                <div className="power-bar-track">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className={`power-bar-segment ${i < myPowerupScore ? "filled" : ""}`}
                    />
                  ))}
                </div>
                <span className={`power-bar-value ${myPowerupScore > 0 ? "charged" : ""}`}>
                  {myPowerupScore > 0 ? "READY" : "EMPTY"}
                </span>
              </div>

              <div className="dual-dpad">
                <div className="dpad-group">
                  <div className="dpad-group-label">Move</div>
                  <div className="dpad">
                    <button className="dpad-btn up" onClick={() => makeMove(-boardSideLen)}>W</button>
                    <div className="dpad-mid">
                      <button className="dpad-btn left" onClick={() => makeMove(-1)}>A</button>
                      <button className="dpad-btn down" onClick={() => makeMove(boardSideLen)}>S</button>
                      <button className="dpad-btn right" onClick={() => makeMove(1)}>D</button>
                    </div>
                  </div>
                </div>

                <div className="dpad-group">
                  <div className="dpad-group-label">Power ⚡</div>
                  <div className={`dpad ${myPowerupScore > 0 ? "dpad-powered" : "dpad-dim"}`}>
                    <button className="dpad-btn up power-btn" onClick={() => usePower(-boardSideLen)}>▲</button>
                    <div className="dpad-mid">
                      <button className="dpad-btn left power-btn" onClick={() => usePower(-1)}>◄</button>
                      <button className="dpad-btn down power-btn" onClick={() => usePower(boardSideLen)}>▼</button>
                      <button className="dpad-btn right power-btn" onClick={() => usePower(1)}>►</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!publicKey && (
            <div className="connect-prompt">
              Connect your wallet to play
            </div>
          )}

          {publicKey && !gameStatus?.isActive && gameStatus?.currentGameId !== null && (gameStatus?.playersCount ?? 0) < maxPlayers && (
            <div className="connect-prompt">
              Waiting for {maxPlayers} players. Ask others to connect and click <b>Register</b> above to start.
            </div>
          )}

          {publicKey && gameStatus?.currentGameId === null && (
            <div className="connect-prompt">
              Game has not started yet. Waiting for the host to start a session.
            </div>
          )}

          {!showGameOverModal &&
            displayGame?.isActive === false &&
            (displayGame?.playersCount ?? 0) >= maxPlayers &&
            (displayGame?.gameEndTimestamp ?? 0) > 0 &&
            Math.floor(Date.now() / 1000) >= (displayGame?.gameEndTimestamp ?? 0) && (
              <div className="game-over">
                <h2>🏆 Game Over!</h2>
                <div className="final-scores">
                  {displayGame.players
                    ?.slice(0, displayGame?.playersCount ?? 0)
                    ?.sort((a, b) => Number(b.score) - Number(a.score))
                    ?.map((p, i) => (
                      <div key={i} className="final-row">
                        <span>{i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"}</span>
                        <span style={{ color: PLAYER_COLORS[(p.id - 1) % PLAYER_COLORS.length] }}>
                          {PLAYER_LABELS[p.id - 1] ?? `P${p.id}`}
                        </span>
                        <span className="final-score">{p.score} pts</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
        </div>

        <div className="side-panel rules-panel">
          <div className="panel-section info-panel">
            <div className="info-tabs" role="tablist" aria-label="Game information">
              <button
                type="button"
                className={`info-tab ${infoTab === "rules" ? "active" : ""}`}
                onClick={() => setInfoTab("rules")}
                role="tab"
                aria-selected={infoTab === "rules"}
              >
                Rules
              </button>
              <button
                type="button"
                className={`info-tab ${infoTab === "rewards" ? "active" : ""}`}
                onClick={() => setInfoTab("rewards")}
                role="tab"
                aria-selected={infoTab === "rewards"}
              >
                Rewards
              </button>
            </div>

            <div className="info-content" role="tabpanel">
              {infoTab === "rules" ? (
                <ul className="rules-list">
                  <li>
                    Connect your wallet and <strong>register</strong> by paying 0.001 SOL to join the match.
                  </li>
                  <li>The game starts once 2 players join and runs for a fixed time.</li>
                  <li>
                    Move using <strong>WASD</strong>. Fire power with <strong>Arrow Keys</strong>.
                  </li>
                  <li>
                    Stand on the <span className="king-em">👑 King Tile</span> to earn +1 score per second.
                  </li>
                  <li>
                    Step on <span style={{ color: "#64dc64" }}>⚡ Powerup</span> (every 5s) to charge your power, then use Arrow Keys to blast an enemy in that direction.
                  </li>
                  <li>
                    Watch out for the <span style={{ color: "#ff5050" }}>💣 Bomb</span> (every 10s) — landing on it warps you back to your starting position!
                  </li>
                  <li>Collide with another player to push them back 2 steps.</li>
                  <li>Beware — other players can push you back 2 steps too.</li>
                </ul>
              ) : (
                <ul className="rules-list">
                  <li>
                    Each point earned <strong>rewards you with 0.000029 SOL</strong>.
                  </li>
                  <li>The longer you stay on the King Tile, the more SOL you earn.</li>
                  <li>When time runs out, your total score is converted into SOL.</li>
                  <li>
                    There are no winners or losers — your earnings depend on how long you control the King Tile.
                  </li>
                  <li>All rewards are automatically transferred to your wallet.</li>
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
};

export default App;
