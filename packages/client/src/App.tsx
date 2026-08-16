/**
 * App shell: join screen -> lobby -> board, plus the card browser.
 *
 * Everything rendered here is a view of engine state; the only writes are
 * actions handed to the server (and optimistically to the local reducer).
 */
import { useMemo, useState } from 'react';
import { useGame } from './net/useGame.ts';
import { Board } from './components/Board.tsx';
import { CardBrowser } from './components/CardBrowser.tsx';

export function App() {
  const game = useGame();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [tab, setTab] = useState<'game' | 'cards'>('game');

  const joined = game.roomCode !== null;
  const canJoin = game.conn === 'open' && name.trim().length > 0 && code.trim().length > 0;

  const status = useMemo(() => {
    if (game.conn === 'connecting') return 'connecting…';
    if (game.conn === 'closed') return 'disconnected — reload to reconnect';
    if (game.conn === 'error') return 'connection error';
    return game.roomCode ? `room ${game.roomCode}` : 'connected';
  }, [game.conn, game.roomCode]);

  return (
    <div className="app">
      <header className="app__bar">
        <h1>
          DBZ<span>CCG</span>
        </h1>
        <nav>
          <button className={tab === 'game' ? 'on' : ''} onClick={() => setTab('game')}>
            Game
          </button>
          <button className={tab === 'cards' ? 'on' : ''} onClick={() => setTab('cards')}>
            Cards {game.cards.length > 0 && <em>{game.cards.length}</em>}
          </button>
        </nav>
        <span className="app__status">
          {status}
          {game.seat !== null && <em> · seat {game.seat + 1}</em>}
          {game.seat === null && joined && <em> · spectating</em>}
          {game.pendingCount > 0 && <em className="app__pending"> · {game.pendingCount} predicted</em>}
        </span>
      </header>

      {tab === 'cards' ? (
        <CardBrowser cards={game.cards} />
      ) : !joined ? (
        <main className="join">
          <h2>Join a room</h2>
          <p className="join__hint">
            Any unused code creates that room. First two players take the seats; everyone after spectates.
          </p>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="Goku" />
          </label>
          <label>
            Room code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={8}
              placeholder="KAME"
            />
          </label>
          <div className="join__actions">
            <button disabled={!canJoin} onClick={() => game.join(code, name)}>
              Take a seat
            </button>
            <button disabled={!canJoin} className="ghost" onClick={() => game.join(code, name, true)}>
              Spectate
            </button>
          </div>
        </main>
      ) : game.state ? (
        <Board
          state={game.state}
          seat={game.seat}
          onAction={(kind) => {
            if (kind === 'advanceStep') game.send({ type: 'advanceStep' });
            else if (kind === 'powerUp' && game.seat !== null) game.send({ type: 'powerUp', playerIdx: game.seat });
            else if (kind === 'pass') game.send({ type: 'pass' });
          }}
          onOpenCard={() => {
            /* card detail panel lands with the deck builder */
          }}
        />
      ) : (
        <main className="lobby">
          <h2>Room {game.roomCode}</h2>
          <ul className="lobby__seats">
            {(game.lobby?.seats ?? []).map((s) => (
              <li key={s.idx} className={s.ready ? 'ready' : ''}>
                <span className={`dot ${s.connected ? 'dot--on' : 'dot--off'}`} />
                <strong>{s.name}</strong>
                <span>{s.deckName ? `deck: ${s.deckName}` : 'no deck yet'}</span>
                <span>{s.ready ? 'ready' : 'not ready'}</span>
              </li>
            ))}
          </ul>
          {game.lobby && game.lobby.spectators > 0 && <p>{game.lobby.spectators} spectating</p>}
          <p className="lobby__todo">
            Deck submission lands with the deck builder — until then, load a deck with the server's
            <code> loadDeck </code> action.
          </p>
        </main>
      )}

      {game.errors.length > 0 && (
        <div className="errors">
          {game.errors.slice(-3).map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}
    </div>
  );
}
