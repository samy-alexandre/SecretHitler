const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Stockage global des parties en cours
const games = {};

// Fonction pour distribuer les rôles selon les règles officielles de Secret Hitler
function assignRoles(playerList) {
    const count = playerList.length;
    let roles = [];

    if (count <= 6) {
        // 5-6 joueurs : 3-4 Libéraux, 1 Fasciste, 1 Hitler
        roles = ["Hitler", "Fascist"];
        while (roles.length < count) roles.push("Liberal");
    } else if (count <= 8) {
        // 7-8 joueurs : 5-6 Libéraux, 2 Fascistes, 1 Hitler
        roles = ["Hitler", "Fascist", "Fascist"];
        while (roles.length < count) roles.push("Liberal");
    } else {
        // 9-10 joueurs : 6-7 Libéraux, 3 Fascistes, 1 Hitler
        roles = ["Hitler", "Fascist", "Fascist", "Fascist"];
        while (roles.length < count) roles.push("Liberal");
    }

    // Mélanger le paquet de rôles
    return roles.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    console.log(`Un joueur s'est connecté : ${socket.id}`);

    // CREER UN SALON
    socket.on('createGame', (username) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        games[roomCode] = {
            code: roomCode,
            players: [{ id: socket.id, username: username, role: null }],
            status: 'lobby',
            presidentIndex: 0,
            liberalPolicies: 0,
            fascistPolicies: 0,
            currentPresident: null,
            currentChancellor: null
        };

        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        io.to(roomCode).emit('updatePlayers', games[roomCode].players.map(p => p.username));
    });

    // REJOINDRE UN SALON
    socket.on('joinGame', ({ username, roomCode }) => {
        const game = games[roomCode];
        if (!game) return socket.emit('error', 'Salon introuvable !');
        if (game.status !== 'lobby') return socket.emit('error', 'La partie a déjà commencé !');
        if (game.players.length >= 10) return socket.emit('error', 'Le salon est complet (max 10) !');

        game.players.push({ id: socket.id, username: username, role: null });
        socket.join(roomCode);

        io.to(roomCode).emit('updatePlayers', game.players.map(p => p.username));
    });

    // LANCER LA PARTIE
    socket.on('startGame', () => {
        // Trouver à quel salon appartient ce socket
        let roomCode = null;
        for (const code in games) {
            if (games[code].players.some(p => p.id === socket.id)) {
                roomCode = code;
                break;
            }
        }

        const game = games[roomCode];
        if (!game) return;
        if (game.players.length < 2) return socket.emit('error', 'Il faut au moins 2 joueurs pour tester (5 normalement) !');

        game.status = 'playing';
        game.liberalPolicies = 0;
        game.fascistPolicies = 0;
        game.presidentIndex = 0;

        // Distribution sécurisée des rôles côté serveur
        const shuffledRoles = assignRoles(game.players);
        game.players.forEach((player, index) => {
            player.role = shuffledRoles[index];
        });

        const allUsernames = game.players.map(p => p.username);
        game.currentPresident = allUsernames[game.presidentIndex];

        // Envoyer à chaque joueur son rôle en secret
        game.players.forEach(player => {
            io.to(player.id).emit('yourRole', {
                role: player.role,
                allPlayers: allUsernames,
                presidentIndex: game.presidentIndex
            });
        });
    });

    // PROPOSER UN CHANCELIER (NOMINATION)
    socket.on('proposeChancellor', ({ roomCode, chancellorName }) => {
        const game = games[roomCode];
        if (!game) return;

        game.currentChancellor = chancellorName;

        // Trouver le rôle secret du chancelier proposé
        const chancellorPlayer = game.players.find(p => p.username.toLowerCase() === chancellorName.toLowerCase());

        // CONDITION DE VICTOIRE DES FASCISTES : Hitler élu après 3 lois fascistes
        if (game.fascistPolicies >= 3 && chancellorPlayer && chancellorPlayer.role === "Hitler") {
            io.to(roomCode).emit('gameOver', {
                winner: 'FASCIST',
                reason: `Hitler (${chancellorName}) a été élu Chancelier alors que ${game.fascistPolicies} lois fascistes étaient déjà en place !`
            });
            game.status = 'game_over';
            return;
        }

        // Si ce n'est pas fini, on lance le vote pour tout le monde
        io.to(roomCode).emit('startVotingPhase', {
            president: game.currentPresident,
            chancellor: game.currentChancellor
        });
    });

    // PROMULGUER UNE LOI (Session Législative validée)
    socket.on('enactPolicy', ({ roomCode, policyType }) => {
        const game = games[roomCode];
        if (!game) return;

        if (policyType === 'LIBERAL') {
            game.liberalPolicies++;
        } else {
            game.fascistPolicies++;
        }

        // Synchroniser les compteurs sur les écrans de tous les joueurs
        io.to(roomCode).emit('policyEnactedUpdate', {
            policyType: policyType,
            liberalCount: game.liberalPolicies,
            fascistCount: game.fascistPolicies
        });

        // VÉRIFICATION DES VICTOIRES PAR COMPTEUR
        if (game.liberalPolicies >= 5) {
            io.to(roomCode).emit('gameOver', { winner: 'LIBERAL', reason: '5 lois libérales ont été promulguées !' });
            game.status = 'game_over';
        } else if (game.fascistPolicies >= 6) {
            io.to(roomCode).emit('gameOver', { winner: 'FASCIST', reason: '6 lois fascistes ont été promulguées !' });
            game.status = 'game_over';
        }
    });

    // CHANGER DE TOUR (BOUTON END TERM)
    socket.on('endTerm', ({ roomCode }) => {
        const game = games[roomCode];
        if (!game) return;

        // Passer au joueur suivant
        game.presidentIndex = (game.presidentIndex + 1) % game.players.length;
        game.currentPresident = game.players[game.presidentIndex].username;
        game.currentChancellor = null;

        // On informe tous les clients de lancer le nouveau tour avec le nouveau président
        io.to(roomCode).emit('newTurn', {
            presidentIndex: game.presidentIndex,
            currentPresident: game.currentPresident
        });
    });

    // DECONNEXION
    socket.on('disconnect', () => {
        for (const roomCode in games) {
            const game = games[roomCode];
            const index = game.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                game.players.splice(index, 1);
                if (game.players.length === 0) {
                    delete games[roomCode];
                } else {
                    io.to(roomCode).emit('updatePlayers', game.players.map(p => p.username));
                    if (game.status === 'playing') {
                        io.to(roomCode).emit('gameReset', 'Un joueur a quitté, la partie est annulée.');
                        delete games[roomCode];
                    }
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur Secret Hitler actif sur http://localhost:${PORT}`);
});
