const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const games = {};

// Génération d'un deck complet aux règles officielles (6 Libérales, 11 Fascistes)
function generateDeck() {
    let deck = [];
    for (let i = 0; i < 6; i++) deck.push('LIBERAL');
    for (let i = 0; i < 11; i++) deck.push('FASCIST');
    return deck.sort(() => Math.random() - 0.5);
}

// Attribution secrète des rôles selon le nombre de joueurs présents
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
    
    // ACTION : Créer un salon de jeu
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

    // ACTION : Rejoindre un salon existant via son code
    socket.on('joinGame', ({ username, roomCode }) => {
        const game = games[roomCode];
        if (!game) return socket.emit('error', 'Salon introuvable !');
        if (game.status !== 'lobby') return socket.emit('error', 'Partie déjà lancée !');
        if (game.players.length >= 10) return socket.emit('error', 'Salon complet !');

        game.players.push({ id: socket.id, username: username, isBot: false, role: null });
        socket.join(roomCode);
        io.to(roomCode).emit('updatePlayers', games[roomCode].players.map(p => p.username));
    });

    // ACTION : Lancer la partie (Remplissage automatique avec des Bots jusqu'à 5 joueurs)
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

    // ACTION : Le Président choisit et propose un Chancelier
    socket.on('proposeChancellor', ({ roomCode, chancellorName }) => {
        const game = games[roomCode];
        if (!game) return;

        game.currentChancellor = chancellorName;
        game.votesReceived = {}; 

        // Condition de victoire Fasciste immédiate (Hitler élu après 3 lois fascistes)
        const chancellorPlayer = game.players.find(p => p.username === chancellorName);
        if (game.fascistPolicies >= 3 && chancellorPlayer && chancellorPlayer.role === "Hitler") {
            io.to(roomCode).emit('gameOver', {
                winner: 'FASCIST',
                reason: `Hitler (${chancellorName}) a été élu Chancelier avec 3 lois fascistes sur le plateau !`
            });
            game.status = 'game_over';
            return;
        }

        // Les bots calculent et génèrent leur vote instantanément
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

    // ACTION : Enregistrement du vote d'un joueur réel
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
                // Gestion de la pioche (mélange de la défausse si moins de 3 cartes dans la pioche)
                if (game.deck.length < 3) {
                    game.deck = generateDeck();
                    game.discardPile = 0;
                }
                game.legislativeCards = [game.deck.pop(), game.deck.pop(), game.deck.pop()];

                const currentPresPlayer = game.players.find(p => p.username === game.currentPresident);
                
                if (currentPresPlayer && currentPresPlayer.isBot) {
                    // IA DU PRÉSIDENT BOT : Il défausse automatiquement une carte après 2.5 secondes
                    setTimeout(() => {
                        handlePresidentDiscardLogic(game, roomCode, Math.floor(Math.random() * 3));
                    }, 2500);
                } else {
                    // PRÉSIDENT HUMAIN : On lui notifie qu'il doit ouvrir l'interface législative
                    io.to(roomCode).emit('triggerLegislativeSession', {
                        president: game.currentPresident,
                        chancellor: game.currentChancellor,
                        cardsCount: game.deck.length,
                        discardCount: game.discardPile
                    });
                }
            } else {
                // Vote rejeté, passage automatique au gouvernement suivant
                setTimeout(() => {
                    io.to(roomCode).emit('cleanVoteBar');
                    handleEndTermLogic(game, roomCode);
                }, 3000);
            }
        }
    });

    // ACTION : Un président humain demande à regarder ses 3 cartes piochées
    socket.on('requestPresidentCards', ({ roomCode, username }) => {
        const game = games[roomCode];
        if (!game) return;
        if (game.currentPresident === username) {
            socket.emit('presidentCardsReceived', game.legislativeCards);
        }
    });

    // ACTION : Le président retire une carte du paquet législatif
    socket.on('presidentDiscard', ({ roomCode, discardedIndex }) => {
        const game = games[roomCode];
        if (!game) return;
        handlePresidentDiscardLogic(game, roomCode, discardedIndex);
    });

    // Logique globale de défausse du Président (Humain et Bot)
    function handlePresidentDiscardLogic(game, roomCode, discardedIndex) {
        game.legislativeCards.splice(discardedIndex, 1);
        game.discardPile++;

        const chancellorPlayer = game.players.find(p => p.username === game.currentChancellor);

        if (chancellorPlayer && chancellorPlayer.isBot) {
            // IA DU CHANCELIER BOT : Il défausse sa carte et applique la loi restante immédiatement
            setTimeout(() => {
                const botDiscardIdx = Math.floor(Math.random() * game.legislativeCards.length);
                game.legislativeCards.splice(botDiscardIdx, 1);
                game.discardPile++;

                const finalPolicy = game.legislativeCards[0];
                enactFinalPolicy(game, roomCode, finalPolicy);
            }, 2000);
        } else {
            // CHANCELIER HUMAIN : On lui transmet les 2 lois restantes à l'écran
            io.to(roomCode).emit('chancellorCardsPhase', {
                chancellor: game.currentChancellor,
                cards: game.legislativeCards
            });
        }
    }

    // ACTION : Le chancelier humain valide sa défausse et applique la loi finale
    socket.on('chancellorDiscard', ({ roomCode, discardedIndex }) => {
        const game = games[roomCode];
        if (!game) return;

        game.legislativeCards.splice(discardedIndex, 1);
        game.discardPile++;

        const finalPolicy = game.legislativeCards[0];
        enactFinalPolicy(game, roomCode, finalPolicy);
    });

    // Fonction d'application d'une loi sur le plateau graphique
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

        // Vérification des scores max (Lois)
        if (game.liberalPolicies >= 5) {
            io.to(roomCode).emit('gameOver', { winner: 'LIBERAL', reason: '5 lois libérales ont été promulguées !' });
            game.status = 'game_over';
        } else if (game.fascistPolicies >= 6) {
            io.to(roomCode).emit('gameOver', { winner: 'FASCIST', reason: '6 lois fascistes ont été promulguées !' });
            game.status = 'game_over';
        } else {
            // Si le président actuel est un Bot, le tour se termine tout seul au bout de 3 secondes
            const currentPresPlayer = game.players.find(p => p.username === game.currentPresident);
            if (currentPresPlayer && currentPresPlayer.isBot) {
                setTimeout(() => {
                    handleEndTermLogic(game, roomCode);
                }, 3000);
            }
        }
    }

    // ACTION : Un président humain clique sur "END TERM"
    socket.on('endTerm', ({ roomCode }) => {
        const game = games[roomCode];
        if (!game) return;
        handleEndTermLogic(game, roomCode);
    });

    // Passer le flambeau de la présidence au joueur suivant de la liste (ordre horaire)
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
