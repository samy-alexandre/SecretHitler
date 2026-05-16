const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const games = {};

function generateDeck() {
    let deck = [];
    for (let i = 0; i < 6; i++) deck.push('LIBERAL');
    for (let i = 0; i < 11; i++) deck.push('FASCIST');
    return deck.sort(() => Math.random() - 0.5);
}

function getDeckComposition(deck) {
    let lib = 0;
    let fasc = 0;
    deck.forEach(c => {
        if(c === 'LIBERAL') lib++;
        else fasc++;
    });
    return { total: deck.length, liberal: lib, fascist: fasc };
}

function assignRoles(playerList) {
    const count = playerList.length;
    let roles = [];
    roles.push("Hitler");
    roles.push("Fascist");
    while (roles.length < count) {
        roles.push("Liberal");
    }
    return roles.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    
    socket.on('createGame', (username) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        games[roomCode] = {
            code: roomCode,
            players: [{ id: socket.id, username: username, isBot: false, role: null }],
            status: 'lobby',
            presidentIndex: 0,
            liberalPolicies: 0,
            fascistPolicies: 0,
            currentPresident: null,
            currentChancellor: null,
            votesReceived: {},
            deck: [],
            discardPile: []
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        io.to(roomCode).emit('updatePlayers', games[roomCode].players.map(p => p.username));
    });

    socket.on('joinGame', ({ username, roomCode }) => {
        const game = games[roomCode];
        if (!game) return socket.emit('error', 'Salon introuvable !');
        if (game.status !== 'lobby') return socket.emit('error', 'Partie déjà lancée !');
        
        game.players.push({ id: socket.id, username: username, isBot: false, role: null });
        socket.join(roomCode);
        io.to(roomCode).emit('updatePlayers', games[roomCode].players.map(p => p.username));
    });

    socket.on('startGame', () => {
        let roomCode = null;
        for (const code in games) {
            if (games[code].players.some(p => p.id === socket.id)) { roomCode = code; break; }
        }
        const game = games[roomCode];
        if (!game) return;

        let botCount = 1;
        while (game.players.length < 5) {
            game.players.push({
                id: `bot_${botCount}`,
                username: `🤖 BOT ${botCount}`,
                isBot: true,
                role: null
            });
            botCount++;
        }

        game.status = 'playing';
        game.liberalPolicies = 0;
        game.fascistPolicies = 0;
        game.presidentIndex = 0;
        game.deck = generateDeck();
        game.discardPile = [];
        game.legislativeCards = [];

        const shuffledRoles = assignRoles(game.players);
        game.players.forEach((player, index) => { player.role = shuffledRoles[index]; });

        const allUsernames = game.players.map(p => p.username);
        game.currentPresident = game.players[game.presidentIndex].username;

        game.players.forEach(player => {
            if (!player.isBot) {
                let visibleRoles = {};
                if (player.role === 'Fascist' || player.role === 'Hitler') {
                    game.players.forEach(other => {
                        if (other.username !== player.username && (other.role === 'Fascist' || other.role === 'Hitler')) {
                            visibleRoles[other.username] = other.role;
                        }
                    });
                }

                io.to(player.id).emit('yourRole', {
                    role: player.role,
                    allPlayers: allUsernames,
                    visibleRoles: visibleRoles,
                    presidentIndex: game.presidentIndex,
                    roomCode: roomCode,
                    deckComposition: getDeckComposition(game.deck),
                    discardCount: game.discardPile.length
                });
            }
        });
    });

    socket.on('proposeChancellor', ({ roomCode, chancellorName }) => {
        const game = games[roomCode];
        if (!game) return;

        game.currentChancellor = chancellorName;
        game.votesReceived = {}; 

        const chancellorPlayer = game.players.find(p => p.username === chancellorName);
        if (game.fascistPolicies >= 3 && chancellorPlayer && chancellorPlayer.role === "Hitler") {
            io.to(roomCode).emit('gameOver', {
                winner: 'FASCIST',
                reason: `Hitler (${chancellorName}) a été élu Chancelier avec 3 lois fascistes sur le plateau !`
            });
            game.status = 'game_over';
            return;
        }

        game.players.forEach(p => {
            if (p.isBot) {
                game.votesReceived[p.username] = Math.random() > 0.3 ? 'ja' : 'nein';
            }
        });

        io.to(roomCode).emit('startVotingPhase', {
            president: game.currentPresident,
            chancellor: game.currentChancellor
        });
    });

    socket.on('playerVote', ({ roomCode, username, vote }) => {
        const game = games[roomCode];
        if (!game) return;

        game.votesReceived[username] = vote.toLowerCase();

        const totalVoted = Object.keys(game.votesReceived).length;
        if (totalVoted === game.players.length) {
            let jaCount = 0;
            let neinCount = 0;
            for (const p in game.votesReceived) {
                if (game.votesReceived[p] === 'ja') jaCount++;
                else neinCount++;
            }

            const passed = jaCount > neinCount;

            io.to(roomCode).emit('voteFinished', {
                votes: game.votesReceived,
                jaCount: jaCount,
                neinCount: neinCount,
                passed: passed
            });

            if (passed) {
                // Remélange uniquement si la pioche est vide pour piocher 3 cartes
                if (game.deck.length < 3) {
                    game.deck = [...game.deck, ...game.discardPile].sort(() => Math.random() - 0.5);
                    game.discardPile = [];
                }
                
                // Descente immédiate à 14 cartes dans la pioche
                game.legislativeCards = [game.deck.pop(), game.deck.pop(), game.deck.pop()];

                io.to(roomCode).emit('updateDeckCounts', {
                    cardsCount: game.deck.length,
                    discardCount: game.discardPile.length,
                    deckComposition: getDeckComposition(game.deck)
                });

                const currentPresPlayer = game.players.find(p => p.username === game.currentPresident);
                if (currentPresPlayer && currentPresPlayer.isBot) {
                    setTimeout(() => {
                        handlePresidentDiscardLogic(game, roomCode, Math.floor(Math.random() * 3));
                    }, 2500);
                } else {
                    io.to(roomCode).emit('triggerLegislativeSession', {
                        president: game.currentPresident,
                        chancellor: game.currentChancellor
                    });
                }
            } else {
                setTimeout(() => {
                    io.to(roomCode).emit('cleanVoteBar');
                    handleEndTermLogic(game, roomCode);
                }, 3000);
            }
        }
    });

    socket.on('requestPresidentCards', ({ roomCode, username }) => {
        const game = games[roomCode];
        if (!game) return;
        if (game.currentPresident === username) {
            socket.emit('presidentCardsReceived', game.legislativeCards);
        }
    });

    socket.on('presidentDiscard', ({ roomCode, discardedIndex }) => {
        const game = games[roomCode];
        if (!game) return;
        handlePresidentDiscardLogic(game, roomCode, discardedIndex);
    });

    function handlePresidentDiscardLogic(game, roomCode, discardedIndex) {
        const discarded = game.legislativeCards.splice(discardedIndex, 1)[0];
        game.discardPile.push(discarded);

        // Envoi de la mise à jour : Discard Pile passe immédiatement à +1
        io.to(roomCode).emit('updateDeckCounts', {
            cardsCount: game.deck.length,
            discardCount: game.discardPile.length,
            deckComposition: getDeckComposition(game.deck)
        });

        const chancellorPlayer = game.players.find(p => p.username === game.currentChancellor);

        if (chancellorPlayer && chancellorPlayer.isBot) {
            setTimeout(() => {
                const botDiscardIdx = Math.floor(Math.random() * game.legislativeCards.length);
                const botDiscarded = game.legislativeCards.splice(botDiscardIdx, 1)[0];
                game.discardPile.push(botDiscarded);

                const finalPolicy = game.legislativeCards[0];
                game.legislativeCards = [];
                enactFinalPolicy(game, roomCode, finalPolicy);
            }, 2000);
        } else {
            io.to(roomCode).emit('chancellorCardsPhase', {
                chancellor: game.currentChancellor,
                cards: game.legislativeCards
            });
        }
    }

    socket.on('chancellorDiscard', ({ roomCode, discardedIndex }) => {
        const game = games[roomCode];
        if (!game) return;

        const discarded = game.legislativeCards.splice(discardedIndex, 1)[0];
        game.discardPile.push(discarded);

        const finalPolicy = game.legislativeCards[0];
        game.legislativeCards = [];
        enactFinalPolicy(game, roomCode, finalPolicy);
    });

    function enactFinalPolicy(game, roomCode, policyType) {
        if (policyType === 'LIBERAL') game.liberalPolicies++;
        else game.fascistPolicies++;

        io.to(roomCode).emit('policyEnactedUpdate', {
            policyType: policyType,
            liberalCount: game.liberalPolicies,
            fascistCount: game.fascistPolicies,
            cardsCount: game.deck.length,
            discardCount: game.discardPile.length,
            deckComposition: getDeckComposition(game.deck)
        });

        if (game.liberalPolicies >= 5) {
            io.to(roomCode).emit('gameOver', { winner: 'LIBERAL', reason: '5 lois libérales ont été promulguées !' });
            game.status = 'game_over';
        } else if (game.fascistPolicies >= 6) {
            io.to(roomCode).emit('gameOver', { winner: 'FASCIST', reason: '6 lois fascistes ont été promulguées !' });
            game.status = 'game_over';
        } else {
            const currentPresPlayer = game.players.find(p => p.username === game.currentPresident);
            if (currentPresPlayer && currentPresPlayer.isBot) {
                setTimeout(() => {
                    handleEndTermLogic(game, roomCode);
                }, 3000);
            }
        }
    }

    socket.on('endTerm', ({ roomCode }) => {
        const game = games[roomCode];
        if (!game) return;
        handleEndTermLogic(game, roomCode);
    });

    function handleEndTermLogic(game, roomCode) {
        game.presidentIndex = (game.presidentIndex + 1) % game.players.length;
        game.currentPresident = game.players[game.presidentIndex].username;
        game.currentChancellor = null;

        io.to(roomCode).emit('newTurn', {
            presidentIndex: game.presidentIndex,
            currentPresident: game.currentPresident,
            deckComposition: getDeckComposition(game.deck),
            discardCount: game.discardPile.length
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Lancement sur http://localhost:${PORT}`));
