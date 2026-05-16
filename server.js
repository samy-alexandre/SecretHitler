const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

let players = [];
let gameState = { started: false, liberalPolicies: 0, fascistPolicies: 0, deck: [] };

function createDeck() {
    let deck = Array(6).fill('Liberal').concat(Array(11).fill('Fascist'));
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('joinGame', (username) => {
        if (gameState.started || players.length >= 10) {
            socket.emit('error', 'Impossible de rejoindre (partie en cours ou complète).');
            return;
        }
        if (players.some(p => p.name.toLowerCase() === username.toLowerCase())) {
            socket.emit('error', 'Ce pseudo est déjà pris.');
            return;
        }
        players.push({ id: socket.id, name: username, role: null });
        io.emit('updatePlayers', players.map(p => p.name));
    });

    socket.on('startGame', () => {
        if (players.length < 5) {
            socket.emit('error', 'Il faut au moins 5 joueurs.');
            return;
        }
        gameState.started = true;
        gameState.deck = createDeck();

        let roles = ['Hitler', 'Fascist', 'Liberal', 'Liberal', 'Liberal'];
        if (players.length >= 6) roles.push('Liberal');
        if (players.length >= 7) roles.push('Fascist');
        if (players.length >= 8) roles.push('Liberal');
        if (players.length >= 9) roles.push('Fascist');
        if (players.length >= 10) roles.push('Liberal');
        roles.sort(() => Math.random() - 0.5);

        players.forEach((player, index) => {
            player.role = roles[index];
            let allies = players.filter((p, i) => roles[i] === 'Fascist' || (players.length <= 6 && roles[i] === 'Hitler')).map(p => p.name);
            let infoText = "Fais passer les lois Libérales ou tue Hitler.";
            if (player.role === 'Fascist') infoText = `Fascistes : ${allies.join(', ')}. Faites élire Hitler !`;
            if (player.role === 'Hitler' && players.length <= 6) infoText = `Tes alliés Fascistes : ${allies.filter(n => n !== player.name).join(', ')}.`;
            
            io.to(player.id).emit('yourRole', { role: player.role, info: infoText });
        });
        io.emit('gameStatus', { started: true });
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        io.emit('updatePlayers', players.map(p => p.name));
        if (gameState.started && players.length < 5) {
            gameState.started = false;
            io.emit('gameReset', 'Un joueur a quitté. Partie réinitialisée.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur sur le port ${PORT}`));
