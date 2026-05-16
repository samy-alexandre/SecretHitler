const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// Stockage des salons (rooms)
let rooms = {};

function createDeck() {
    let deck = Array(6).fill('Liberal').concat(Array(11).fill('Fascist'));
    return deck.sort(() => Math.random() - 0.5);
}

// Génère un code de salon aléatoire à 4 lettres
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
    let currentRoom = null;
    let currentUser = null;

    // Créer un salon privé
    socket.on('createGame', (username) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            players: [{ id: socket.id, name: username, role: null, isBot: false }],
            started: false,
            deck: [],
            liberalPolicies: 0,
            fascistPolicies: 0
        };
        
        currentRoom = roomCode;
        currentUser = username;
        socket.join(roomCode);
        
        socket.emit('roomCreated', roomCode);
        io.to(roomCode).emit('updatePlayers', rooms[roomCode].players.map(p => p.name));
    });

    // Rejoindre un salon via son code
    socket.on('joinGame', ({ username, roomCode }) => {
        const code = roomCode.toUpperCase();
        if (!rooms[code]) {
            socket.emit('error', 'Ce code de salon n\'existe pas.');
            return;
        }
        let room = rooms[code];
        if (room.started || room.players.length >= 10) {
            socket.emit('error', 'Impossible de rejoindre (partie en cours ou complète).');
            return;
        }
        if (room.players.some(p => p.name.toLowerCase() === username.toLowerCase())) {
            socket.emit('error', 'Ce pseudo est déjà pris dans ce salon.');
            return;
        }

        room.players.push({ id: socket.id, name: username, role: null, isBot: false });
        currentRoom = code;
        currentUser = username;
        socket.join(code);

        io.to(code).emit('updatePlayers', room.players.map(p => p.name));
    });

    // Lancer la partie (Peut se lancer de 1 à 10 joueurs)
    socket.on('startGame', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        let room = rooms[currentRoom];

        room.started = true;
        room.deck = createDeck();

        // Si le joueur est TOUT SEUL (1 joueur), on ajoute 4 faux joueurs pour le test
        if (room.players.length === 1) {
            for (let i = 1; i <= 4; i++) {
                room.players.push({ id: `bot_${i}`, name: `Bot_Ami_${i}`, role: null, isBot: true });
            }
        }

        // Configuration des rôles selon le nombre final de joueurs
        let count = room.players.length;
        let roles = ['Hitler', 'Fascist', 'Liberal', 'Liberal', 'Liberal']; // Base pour 5
        if (count >= 6) roles.push('Liberal');
        if (count >= 7) roles.push('Fascist');
        if (count >= 8) roles.push('Liberal');
        if (count >= 9) roles.push('Fascist');
        if (count >= 10) roles.push('Liberal');
        
        // Ajustement de sécurité au cas où la table a moins de 5 joueurs réels (hors mode 1 joueur)
        while (roles.length < count) roles.push('Liberal');
        while (roles.length > count) roles.pop();

        roles.sort(() => Math.random() - 0.5);

        // Distribution des rôles
        room.players.forEach((player, index) => {
            player.role = roles[index];
            
            if (!player.isBot) {
                let allies = room.players
                    .filter((p, i) => roles[i] === 'Fascist' || (count <= 6 && roles[i] === 'Hitler'))
                    .map(p => p.name);

                let infoText = "Fais passer les lois Libérales ou trouve et tue Hitler.";
                if (player.role === 'Fascist') infoText = `Membres Fascistes : ${allies.join(', ')}. Faites élire Hitler !`;
                if (player.role === 'Hitler' && count <= 6) infoText = `Tes alliés Fascistes : ${allies.filter(n => n !== player.name).join(', ')}.`;
                if (player.role === 'Hitler' && count > 6) infoText = "Tu es Hitler. À plus de 6 joueurs, tu ne connais pas tes alliés !";

                io.to(player.id).emit('yourRole', { role: player.role, info: infoText, allPlayers: room.players.map(p => p.name) });
            }
        });

        io.to(currentRoom).emit('gameStatus', { started: true });
    });

    // Gestion des déconnexions
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom].players = rooms[currentRoom].players.filter(p => p.id !== socket.id);
            
            // Si le salon est vide, on le supprime
            if (rooms[currentRoom].players.filter(p => !p.isBot).length === 0) {
                delete rooms[currentRoom];
            } else {
                io.to(currentRoom).emit('updatePlayers', rooms[currentRoom].players.map(p => p.name));
                if (rooms[currentRoom].started) {
                    rooms[currentRoom].started = false;
                    io.to(currentRoom).emit('gameReset', 'Un joueur humain s\'est déconnecté. Retour au salon.');
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur Secret Hitler actif sur le port ${PORT}`));
