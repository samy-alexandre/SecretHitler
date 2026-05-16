const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const games = {};

// Paquet de rôles officiel
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
            votesReceived: {}
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        io.to(roomCode).emit('updatePlayers', games[roomCode].players.map(p => p.username));
    });

    socket.on('joinGame', ({ username, roomCode }) => {
        const game = games[roomCode];
        if (!game) return socket.emit('error', 'Salon introuvable !');
        if (game.status !== 'lobby') return socket.emit('error', 'Partie déjà lancée !');
        if (game.players.length >= 10) return socket.emit('error', 'Salon complet !');

        game.players.push({ id: socket.id, username: username, isBot: false, role: null });
        socket.join(roomCode);
        io.to(roomCode).emit('updatePlayers', game.players.map(p => p.username));
    });

    // COMPLÉTER AVEC DES BOTS ET LANCER
    socket.on('startGame', () => {
        let roomCode = null;
        for (const code in games) {
            if (games[code].players.some(p => p.id === socket.id)) { roomCode = code; break; }
        }
        const game = games[roomCode];
        if (!game) return;

        // AJOUT DES BOTS AUTOMATIQUE SI MOINS DE 5 JOUEURS (OU JUSQU'À FAIRE UNE TABLE DE 6 POUR LE FUN)
        let botCount = 1;
        while (game.players.length < 5) {
            game.players.push({
                id: `bot_${botCount}_${Math.random().toString(36).substring(2,5)}`,
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

    // PROPOSER CHANCELIER
    socket.on('proposeChancellor', ({ roomCode, chancellorName }) => {
        const game = games[roomCode];
        if (!game) return;

        game.currentChancellor = chancellorName;
        game.votesReceived = {}; // Reset votes

        const chancellorPlayer = game.players.find(p => p.username === chancellorName);

        // Victoire Hitler Élu ?
        if (game.fascistPolicies >= 3 && chancellorPlayer && chancellorPlayer.role === "Hitler") {
            io.to(roomCode).emit('gameOver', {
                winner: 'FASCIST',
                reason: `Hitler (${chancellorName}) a été élu Chancelier avec 3 lois fascistes sur le plateau !`
            });
            game.status = 'game_over';
            return;
        }

        // Faire voter automatiquement tous les bots immédiatement
        game.players.forEach(p => {
            if (p.isBot) {
                // Les bots votent "JA" 60% du temps au hasard
                game.votesReceived[p.username] = Math.random() > 0.4 ? 'ja' : 'nein';
            }
        });

        // Informer les vrais joueurs que la phase de vote s'ouvre
        io.to(roomCode).emit('startVotingPhase', {
            president: game.currentPresident,
            chancellor: game.currentChancellor
        });
    });

    // RECUEILLIR LE VOTE D'UN VRAI JOUEUR
    socket.on('playerVote', ({ roomCode, username, vote }) => {
        const game = games[roomCode];
        if (!game) return;

        game.votesReceived[username] = vote.toLowerCase();

        // Est-ce que tout le monde (vrais joueurs + bots) a voté ?
        const totalVoted = Object.keys(game.votesReceived).length;
        if (totalVoted === game.players.length) {
            // Calculer les résultats
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
        }
    });

    // PROMULGUER UNE LOI
    socket.on('enactPolicy', ({ roomCode, policyType }) => {
        const game = games[roomCode];
        if (!game) return;

        if (policyType === 'LIBERAL') game.liberalPolicies++;
        else game.fascistPolicies++;

        io.to(roomCode).emit('policyEnactedUpdate', {
            policyType: policyType,
            liberalCount: game.liberalPolicies,
            fascistCount: game.fascistPolicies
        });

        if (game.liberalPolicies >= 5) {
            io.to(roomCode).emit('gameOver', { winner: 'LIBERAL', reason: '5 lois libérales ont été promulguées !' });
            game.status = 'game_over';
        } else if (game.fascistPolicies >= 6) {
            io.to(roomCode).emit('gameOver', { winner: 'FASCIST', reason: '6 lois fascistes ont été promulguées !' });
            game.status = 'game_over';
        }
    });

    // FIN DE TOUR (END TERM)
    socket.on('endTerm', ({ roomCode }) => {
        const game = games[roomCode];
        if (!game) return;

        game.presidentIndex = (game.presidentIndex + 1) % game.players.length;
        game.currentPresident = game.players[game.presidentIndex].username;
        game.currentChancellor = null;

        io.to(roomCode).emit('newTurn', {
            presidentIndex: game.presidentIndex,
            currentPresident: game.currentPresident
        });
    });

    socket.on('disconnect', () => {
        // Nettoyage classique si déconnexion...
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Lancement sur http://localhost:${PORT}`));
