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

function assignRoles(playerList) {
    const count = playerList.length;
    let roles = [];
    if (count <= 6) {
        roles = ["Hitler", "Fascist"];
        while (roles.length < count) roles.push("Liberal");
    } else if (count <= 8) {
        roles = ["Hitler", "Fascist", "Fascist"];
        while (roles.length < count) roles.push("Liberal");
    } else {
        roles = ["Hitler", "Fascist", "Fascist", "Fascist"];
        while (roles.length < count) roles.push("Liberal");
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
            discardPile: 0,
            legislativeCards: []
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        io.to(roomCode).emit('updatePlayers', games[roomCode].players.map(p => p.username));
    });

    socket.on('joinGame', ({ username, roomCode }) => {
        const game = games[roomCode];
        if (!game) return socket.emit('error', 'Salon introuvable !');
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
                username: `🤖 Bot ${botCount}`,
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
        game.discardPile = 0;

        const shuffledRoles = assignRoles(game.players);
        game.players.forEach((player, index) => { player.role = shuffledRoles[index]; });

        const allUsernames = game.players.map(p => p.username);
        game.currentPresident = game.players[game.presidentIndex].username;

        game.players.forEach(player => {
            if (!player.isBot) {
                io.to(player.id).emit('yourRole', {
                    role: player.role,
                    allPlayers: allUsernames,
                    presidentIndex: game.presidentIndex,
                    roomCode: roomCode
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
                if (game.deck.length < 3) {
                    game.deck = generateDeck();
                    game.discardPile = 0;
                }
                game.legislativeCards = [game.deck.pop(), game.deck.pop(), game.deck.pop()];

                // RECONNAISSANCE DU PRÉSIDENT (BOT OU HUMAIN)
                const currentPresPlayer = game.players.find(p => p.username === game.currentPresident);
                
                if (currentPresPlayer && currentPresPlayer.isBot) {
                    // SI LE PRÉSIDENT EST ET RESTE UN BOT : Il pioche et défausse automatiquement après 2 secondes
                    setTimeout(() => {
                        handlePresidentDiscardLogic(game, roomCode, Math.floor(Math.random() * 3));
                    }, 2000);
                } else {
                    // SI LE PRÉSIDENT EST HUMAIN : On attend qu'il clique sur son bouton
                    io.to(roomCode).emit('triggerLegislativeSession', {
                        president: game.currentPresident,
                        chancellor: game.currentChancellor,
                        cardsCount: game.deck.length,
                        discardCount: game.discardPile
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

    // Centralisation de la défausse du président pour humain ET bot
    function handlePresidentDiscardLogic(game, roomCode, discardedIndex) {
        game.legislativeCards.splice(discardedIndex, 1);
        game.discardPile++;

        const chancellorPlayer = game.players.find(p => p.username === game.currentChancellor);

        if (chancellorPlayer && chancellorPlayer.isBot) {
            // SI LE CHANCELIER EST UN BOT : Il choisit instantanément sa carte
            setTimeout(() => {
                const botDiscardIdx = Math.floor(Math.random() * game.legislativeCards.length);
                game.legislativeCards.splice(botDiscardIdx, 1);
                game.discardPile++;

                const finalPolicy = game.legislativeCards[0];
                enactFinalPolicy(game, roomCode, finalPolicy);
            }, 2000);
        } else {
            // SI LE CHANCELIER EST HUMAIN : On lui envoie ses 2 options
            io.to(roomCode).emit('chancellorCardsPhase', {
                chancellor: game.currentChancellor,
                cards: game.legislativeCards
            });
        }
    }

    socket.on('chancellorDiscard', ({ roomCode, discardedIndex }) => {
        const game = games[roomCode];
        if (!game) return;

        game.legislativeCards.splice(discardedIndex, 1);
        game.discardPile++;

        const finalPolicy = game.legislativeCards[0];
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
            discardCount: game.discardPile
        });

        if (game.liberalPolicies >= 5) {
            io.to(roomCode).emit('gameOver', { winner: 'LIBERAL', reason: '5 lois libérales ont été promulguées !' });
            game.status = 'game_over';
        } else if (game.fascistPolicies >= 6) {
            io.to(roomCode).emit('gameOver', { winner: 'FASCIST', reason: '6 lois fascistes ont été promulguées !' });
            game.status = 'game_over';
        } else {
            // Si le président en cours est un bot, on passe automatiquement au tour d'après
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
        game.legislativeCards = [];

        io.to(roomCode).emit('newTurn', {
            presidentIndex: game.presidentIndex,
            currentPresident: game.currentPresident
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Lancement sur http://localhost:${PORT}`));
