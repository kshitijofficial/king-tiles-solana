import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import "./App.css";
import { BackgroundMusic } from "./BackgroundMusic";
import { useMoveSound } from "./useMoveSound";
import { useKingPowerSound } from "./useKingPowerSound";
import { useEmergencyCountdownSound } from "./useEmergencyCountdownSound";

// Must match the program used by the relayer (from target/idl or KING_TILES_PROGRAM_ID)
const PROGRAM_ID = new PublicKey(
  typeof process !== "undefined" && process.env?.REACT_APP_PROGRAM_ID
    ? process.env.REACT_APP_PROGRAM_ID
    : "39mbUDtnBeDfF5ozhTtVgQYWudeDPoDx6HnBEVtvpgGG"
);
const TREASURY_PUBKEY = new PublicKey(
  "86uKSrcwj3j6gaSkK5Ggvt4ni5rokpBhrk2X2jUjDUoA"
);
//for fallback only
const GAME_ID = 5;
const BOARD_SIZE = 144;
const COLS = 12;
const RELAYER_URL = "http://localhost:8787";
const ER_ENDPOINT = "https://devnet.magicblock.app/";

const EMPTY = 0;
const KING_MARK = 5;
const REGISTRATION_FEE_LAMPORTS = 1_000_000; // 0.001 SOL
const MAKE_MOVE_DISCRIMINATOR = [78, 77, 152, 203, 222, 211, 208, 233];
const REGISTER_PLAYER_DISCRIMINATOR = [242, 146, 194, 234, 234, 145, 228, 42];

const PLAYER_COLORS = ["#4FC3F7", "#EF5350", "#66BB6A", "#FFA726"];
const PLAYER_LABELS = ["P1", "P2", "P3", "P4"];

// Pre-computed positions so Math.random() isn't called on every render
const COIN_X_POSITIONS = Array.from({ length: 15 }, (_, i) =>
  parseFloat((10 + (i * 5.4) % 78).toFixed(1))
);

interface PlayerInfo {
  id: number;
  player: string;
  score: string;
  currentPosition: number;
}

interface GameStatus {
  ok: boolean;
  source?: string;
  currentGameId: number | null;
  boardPDA?: string;
  playersCount?: number;
  isActive?: boolean;
  gameEndTimestamp?: number;
  secondsRemaining?: number;
  players?: PlayerInfo[];
  board?: number[][];
  message?: string;
}

function getBoardPDA(gameId: number): PublicKey {
  const gameIdBuf = Buffer.alloc(8);
  gameIdBuf.writeBigUInt64LE(BigInt(gameId));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("board"), TREASURY_PUBKEY.toBuffer(), gameIdBuf],
    PROGRAM_ID
  );
  return pda;
}

function buildRegisterPlayerIx(
  payer: PublicKey,
  boardPDA: PublicKey,
  gameId: number
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8);
  Buffer.from(REGISTER_PLAYER_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(BigInt(gameId), 8);

  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: boardPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TREASURY_PUBKEY, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildMakeMoveIx(
  payer: PublicKey,
  boardPDA: PublicKey,
  gameId: number,
  playerId: number,
  movePosition: number
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 1 + 2);
  Buffer.from(MAKE_MOVE_DISCRIMINATOR).copy(data, 0);
  data.writeBigUInt64LE(BigInt(gameId), 8);
  data.writeUInt8(playerId, 16);
  data.writeInt16LE(movePosition, 17);

  return new TransactionInstruction({
    keys: [
      { pubkey: TREASURY_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: boardPDA, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function moveLabel(m: number): string {
  if (m === -12) return "UP";
  if (m === 12) return "DOWN";
  if (m === -1) return "LEFT";
  if (m === 1) return "RIGHT";
  return String(m);
}

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
  const [movePending, setMovePending] = useState(false);
  const [registerPending, setRegisterPending] = useState(false);
  const [showKingNotif, setShowKingNotif] = useState(false);
  const [kingNotifKey, setKingNotifKey] = useState(0);
  const [showGameOverModal, setShowGameOverModal] = useState(false);
  const [showTransferAnim, setShowTransferAnim] = useState(false);
  const [endedGamePlayers, setEndedGamePlayers] = useState<PlayerInfo[]>([]);
  const [endedGamePlayerCount, setEndedGamePlayerCount] = useState(0);
  const [sessionFunded, setSessionFunded] = useState(false);
  const [infoTab, setInfoTab] = useState<"rules" | "rewards">("rules");
  const lastScoreRef = useRef<number>(0);
  const prevIsActiveRef = useRef<boolean | undefined>(undefined);
  const prevPlayerPositionsRef = useRef<Map<number, number> | null>(null);
  const prevPlayerScoresRef = useRef<Map<number, number> | null>(null);
  const kingStreakRef = useRef<Map<number, number>>(new Map());
  const kingTileIndexRef = useRef<number | null>(null);
  const { playMoveSound } = useMoveSound(0.1);
  const { playKingPower } = useKingPowerSound(0.15);
  const { playEmergencyTick } = useEmergencyCountdownSound(0.17);

  const myPlayerId = useMemo(() => {
    if (!sessionKeypair || !gameStatus?.players) return null;
    const addr = sessionKeypair.publicKey.toBase58();
    const found = gameStatus.players.find((p) => p.player === addr);
    return found ? found.id : null;
  }, [sessionKeypair, gameStatus?.players]);

  const myScore = useMemo(() => {
    if (!myPlayerId || !gameStatus?.players) return 0;
    const p = gameStatus.players.find((x) => x.id === myPlayerId);
    return p ? Number(p.score) : 0;
  }, [myPlayerId, gameStatus?.players]);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [`${new Date().toLocaleTimeString()} ${msg}`, ...prev].slice(0, 30));
  }, []);

  // Fund session keypair on devnet so it can pay registration fees and sign moves
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
        addLog("Funding session key via airdrop...");
        const sig = await devnetConnection.requestAirdrop(
          sessionKeypair.publicKey,
          LAMPORTS_PER_SOL
        );
        await devnetConnection.confirmTransaction(sig, "confirmed");
        if (!cancelled) {
          setSessionFunded(true);
          addLog("Session key funded.");
        }
      } catch {
        if (cancelled) return;
        addLog("Airdrop failed, funding via wallet transfer...");
        try {
          if (!publicKey || !sendTransaction) return;
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: sessionKeypair.publicKey,
              lamports: Math.round(0.01 * LAMPORTS_PER_SOL),
            })
          );
          const sig2 = await sendTransaction(tx, devnetConnection);
          await devnetConnection.confirmTransaction(sig2, "confirmed");
          if (!cancelled) {
            setSessionFunded(true);
            addLog("Session key funded via wallet.");
          }
        } catch (e2: any) {
          if (!cancelled)
            addLog("Failed to fund session key: " + (e2?.message?.slice(0, 60) || ""));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sessionKeypair, devnetConnection, publicKey, sendTransaction, addLog]);

  // King position notification — pops fresh every second the player is on the king tile
  useEffect(() => {
    if (!myPlayerId || !gameStatus?.isActive || !gameStatus?.playersCount) {
      setShowKingNotif(false);
      return;
    }
    const p = gameStatus.players?.find((x) => x.id === myPlayerId);
    const score = p ? Number(p.score) : 0;
    if (score > lastScoreRef.current) {
      lastScoreRef.current = score;
      // Increment key to force remount → animation replays each second
      setKingNotifKey((k) => k + 1);
      setShowKingNotif(true);
      const t = setTimeout(() => setShowKingNotif(false), 1200);
      return () => clearTimeout(t);
    }
    lastScoreRef.current = score;
  }, [gameStatus?.players, gameStatus?.isActive, myPlayerId, gameStatus?.playersCount]);

  // Detect active → inactive transition to trigger Game Over modal + transfer animation
  useEffect(() => {
    const isActive = gameStatus?.isActive;
    if (isActive === undefined || isActive === null) return;

    if (prevIsActiveRef.current === true && isActive === false) {
      setShowKingNotif(false);
      setEndedGamePlayers(gameStatus?.players ?? []);
      setEndedGamePlayerCount(gameStatus?.playersCount ?? 0);
      setShowGameOverModal(true);
      setShowTransferAnim(true);
      setTimeout(() => setShowTransferAnim(false), 4500);
    }
    prevIsActiveRef.current = isActive;
  }, [gameStatus]);

  // Move SFX: play a short sound each time any player position changes.
  useEffect(() => {
    const players = gameStatus?.players?.slice(0, gameStatus?.playersCount ?? 0) ?? [];
    if (!players.length || !gameStatus?.isActive) {
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

    // Polling can batch updates, so play up to 3 quick blips.
    const blips = Math.min(movedCount, 3);
    for (let i = 0; i < blips; i += 1) {
      window.setTimeout(() => playMoveSound(), i * 90);
    }

    prevPlayerPositionsRef.current = nextMap;
  }, [gameStatus?.players, gameStatus?.playersCount, gameStatus?.isActive, playMoveSound]);

  // King scoring SFX: rising tone each second a player keeps scoring on king.
  useEffect(() => {
    const players = gameStatus?.players?.slice(0, gameStatus?.playersCount ?? 0) ?? [];
    if (!players.length || !gameStatus?.isActive) {
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

      // If polling batches updates, play up to 3 quick power pings.
      const hits = Math.min(delta, 3);
      for (let i = 0; i < hits; i += 1) {
        const level = Math.min(streak - (hits - 1 - i), 10);
        window.setTimeout(() => playKingPower(level), i * 120);
      }
    }

    kingStreakRef.current = newStreaks;
    prevPlayerScoresRef.current = nextScores;
  }, [gameStatus?.players, gameStatus?.playersCount, gameStatus?.isActive, playKingPower]);

  const refetchGameStatus = useCallback(async () => {
    try {
      const res = await fetch(`${RELAYER_URL}/game-status`);
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
  }, []);

  // Poll relayer /game-status (only update board when we get ok response; keep last good state on 503)
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`${RELAYER_URL}/game-status`);
        const data: GameStatus & { error?: string } = await res.json();
        if (active) {
          if (res.ok && data.ok !== false) {
            setGameStatus(data);
            setError(null);
          } else {
            setError(data.error ?? "Game status unavailable");
          }
        }
      } catch {
        if (active) setError("Cannot reach relayer at " + RELAYER_URL);
      }
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  // Countdown timer
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

  // Emergency beep for the last 10 seconds (once per second)
  useEffect(() => {
    if (!gameStatus?.isActive) return;
    if (countdown <= 10 && countdown > 0) {
      playEmergencyTick();
    }
  }, [countdown, gameStatus?.isActive, playEmergencyTick]);

  const gameId = gameStatus?.currentGameId ?? GAME_ID;
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
    if ((gameStatus?.playersCount ?? 0) >= 2) {
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
  }, [sessionKeypair, sessionFunded, boardPDA, gameId, registerPending, gameStatus, myPlayerId, devnetConnection, addLog]);

  // Sign moves with the session keypair and send directly to the ER — no wallet popup.
  const makeMove = useCallback(
    async (movePosition: number) => {
      if (!sessionKeypair || !myPlayerId || movePending) return;
      if (!gameStatus?.isActive) return;

      setMovePending(true);
      try {
        const ix = buildMakeMoveIx(
          sessionKeypair.publicKey,
          boardPDA,
          gameId,
          myPlayerId,
          movePosition
        );
        const tx = new Transaction().add(ix);
        const { blockhash } = await erConnection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = sessionKeypair.publicKey;
        tx.sign(sessionKeypair);
        const sig = await erConnection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
        });

        addLog(`Moved ${moveLabel(movePosition)} (${sig.slice(0, 8)}...)`);
        setTimeout(refetchGameStatus, 1200);
        setTimeout(refetchGameStatus, 2500);
      } catch (e: any) {
        const msg = e?.message?.slice(0, 80) || "Unknown error";
        addLog(`Move failed: ${msg}`);
      }
      setMovePending(false);
    },
    [sessionKeypair, myPlayerId, movePending, gameStatus?.isActive, boardPDA, gameId, erConnection, addLog, refetchGameStatus]
  );

  // Keyboard controls
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      let move: number | null = null;
      switch (e.key) {
        case "ArrowUp":
        case "w":
        case "W":
          move = -12;
          break;
        case "ArrowDown":
        case "s":
        case "S":
          move = 12;
          break;
        case "ArrowLeft":
        case "a":
        case "A":
          move = -1;
          break;
        case "ArrowRight":
        case "d":
        case "D":
          move = 1;
          break;
      }
      if (move !== null) {
        e.preventDefault();
        makeMove(move);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [makeMove]);

  const flatBoard = useMemo(() => {
    if (!gameStatus?.board) return new Array(BOARD_SIZE).fill(0);
    return gameStatus.board.flat();
  }, [gameStatus?.board]);

  // Track king tile index even when a player occupies it (backend may overwrite the tile value).
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

  const statusText = gameStatus?.isActive
    ? "ACTIVE"
    : gameStatus?.currentGameId !== null
    ? `Waiting (${gameStatus?.playersCount ?? 0}/2 players)`
    : "No game";

  return (
    <div className="app">
      <BackgroundMusic />
      {/* ─── Header ─── */}
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

      {/* ─── Fund Transfer Animation ─── */}
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
            💸 Transferring winnings to your wallet…
          </div>
        </div>
      )}

      {/* ─── Game Over Modal ─── */}
      {showGameOverModal && (() => {
        const players = endedGamePlayers.slice(0, endedGamePlayerCount);
        const sorted = [...players].sort(
          (a, b) => Number(b.score) - Number(a.score)
        );
        const winner = sorted[0];
        const isMyWin = winner && myPlayerId === winner.id;
        return (
          <div
            className="game-over-overlay"
            onClick={() => setShowGameOverModal(false)}
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
                    : `👑 ${PLAYER_LABELS[winner.id - 1]} Wins!`}
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
                    <span style={{ color: PLAYER_COLORS[p.id - 1] }}>
                      {PLAYER_LABELS[p.id - 1]}
                    </span>
                    <span className="final-score-modal">{p.score} pts</span>
                  </div>
                ))}
              </div>
              <button
                className="btn-dismiss"
                onClick={() => setShowGameOverModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        );
      })()}

      {/* ─── Wallet & registration ─── */}
      {publicKey && (
        <div className="identity-bar">
          <span className="label">Wallet:</span>
          <span className="mono">{publicKey.toBase58().slice(0, 20)}...</span>
          {myPlayerId ? (
            <span
              className="badge"
              style={{ background: PLAYER_COLORS[myPlayerId - 1] }}
            >
              Player {myPlayerId} · Score: {myScore}
            </span>
          ) : gameStatus?.currentGameId == null ? (
            <span className="badge inactive">Game not started</span>
          ) : (
            <span className="badge inactive">Not registered</span>
          )}
          {publicKey && gameStatus?.currentGameId != null && !gameStatus?.isActive && !myPlayerId && (gameStatus?.playersCount ?? 0) < 2 && (
            <button
              type="button"
              className="btn-register"
              onClick={registerForGame}
              disabled={registerPending || !sessionFunded}
            >
              {!sessionFunded ? "Funding session…" : registerPending ? "Registering…" : `Register (${REGISTRATION_FEE_LAMPORTS / 1e6} SOL)`}
            </button>
          )}
        </div>
      )}

      {/* ─── Main Layout ─── */}
      <div className="main-layout">
        {/* Left panel */}
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
              <span className="value">{gameStatus?.source ?? "N/A"}</span>
            </div>
            {gameStatus?.isActive && (
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

          <div className="panel-section">
            <h3>Players</h3>
            {gameStatus?.players
              ?.slice(0, gameStatus?.playersCount ?? 0)
              ?.map((p, i) => (
              <div
                key={i}
                className={`player-card ${
                  myPlayerId === p.id ? "me" : ""
                }`}
                style={{ borderLeftColor: PLAYER_COLORS[i] }}
              >
                <div className="player-top">
                  <span
                    className="player-label"
                    style={{ color: PLAYER_COLORS[i] }}
                  >
                    {PLAYER_LABELS[i]}
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

        {/* Grid area */}
        <div className="board-area">
          <div className="grid-wrapper">
            <div
              className="grid"
              style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}
            >
              {flatBoard.map((cell, idx) => {
                let cls = "cell";
                let content: React.ReactNode = null;

                const isPlayer = cell >= 1 && cell <= 4;
                const isKingTile = kingTileIndex != null && idx === kingTileIndex;

                if (isPlayer) {
                  cls += ` player-cell p${cell}`;
                  if (myPlayerId === cell) cls += " me";
                  if (isKingTile) cls += " king-occupied";
                  content = (
                    <>
                      {isKingTile && <span className="cell-king-corner">👑</span>}
                      {PLAYER_LABELS[cell - 1]}
                    </>
                  );
                } else if (cell === KING_MARK) {
                  cls += " king";
                  content = "👑";
                } else if (isKingTile) {
                  // If we know the king tile index, keep it visually marked even if the board value is empty.
                  cls += " king";
                  content = "👑";
                }

                return (
                  <div key={idx} className={cls}>
                    {content}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Controls */}
          {gameStatus?.isActive && myPlayerId && (
            <div className="controls">
              <p className="controls-hint">
                Use <b>WASD</b> or <b>Arrow Keys</b> to move — no wallet popups!
              </p>
              <div className="dpad">
                <button
                  className="dpad-btn up"
                  onClick={() => makeMove(-12)}
                  disabled={movePending}
                >
                  ▲
                </button>
                <div className="dpad-mid">
                  <button
                    className="dpad-btn left"
                    onClick={() => makeMove(-1)}
                    disabled={movePending}
                  >
                    ◄
                  </button>
                  <button
                    className="dpad-btn down"
                    onClick={() => makeMove(12)}
                    disabled={movePending}
                  >
                    ▼
                  </button>
                  <button
                    className="dpad-btn right"
                    onClick={() => makeMove(1)}
                    disabled={movePending}
                  >
                    ►
                  </button>
                </div>
              </div>
            </div>
          )}

          {!publicKey && (
            <div className="connect-prompt">
              Connect your wallet to play
            </div>
          )}

          {publicKey && !gameStatus?.isActive && gameStatus?.currentGameId !== null && (gameStatus?.playersCount ?? 0) < 2 && (
            <div className="connect-prompt">
              Waiting for 2 players. Connect a second wallet and click <b>Register</b> above to start.
            </div>
          )}

          {publicKey && gameStatus?.currentGameId === null && (
            <div className="connect-prompt">
              Game has not started yet. Waiting for the host to start a session.
            </div>
          )}

          {/* Fallback game-over panel visible after page refresh (no modal) */}
          {!showGameOverModal &&
            gameStatus?.isActive === false &&
            (gameStatus?.playersCount ?? 0) >= 2 &&
            (gameStatus?.gameEndTimestamp ?? 0) > 0 &&
            Math.floor(Date.now() / 1000) >= (gameStatus?.gameEndTimestamp ?? 0) && (
              <div className="game-over">
                <h2>🏆 Game Over!</h2>
                <div className="final-scores">
                  {gameStatus.players
                    ?.slice(0, gameStatus?.playersCount ?? 0)
                    ?.sort((a, b) => Number(b.score) - Number(a.score))
                    ?.map((p, i) => (
                      <div key={i} className="final-row">
                        <span>{i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"}</span>
                        <span style={{ color: PLAYER_COLORS[p.id - 1] }}>
                          {PLAYER_LABELS[p.id - 1]}
                        </span>
                        <span className="final-score">{p.score} pts</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
        </div>

        {/* Right panel — Info (Rules / Rewards) */}
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
                    Move using <strong>WASD</strong> or <strong>Arrow Keys</strong>.
                  </li>
                  <li>
                    Stand on the <span className="king-em">👑 King Tile</span> to earn +1 score per second.
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
    </div>
  );
};

export default App;
