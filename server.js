```javascript
// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files (your index.html, CSS, JS, sounds)
app.use(express.static(__dirname));

// --- Server-side Game State (The single source of truth) ---
let game = {
    gameStarted: false,
    players: [], // { id, name, score, color, socketId }
    currentPlayerId: null, // ID of the player whose turn it is to SELECT a question
    currentBuzzerPlayerId: null, // ID of the player who successfully buzzed in for the active question
    boardState: {}, // { '0-0': { state: 'correct', playerId: 'xyz', failedPlayerIds: [] }, ... }
    activeCardKey: null, // Key of the card currently flipped and being answered
    currentQuestionText: null, // Text of the current question being displayed
    currentWager: 0, // Current value of the question (or DD wager)
    historyStack: [], // For undo functionality
    scoreHistory: {}, // For chart
    answeredCluesCount: 0,
    turnCounter: 0,
    finalJeopardyData: null, // { category, question, answer }
    finalJeopardyWagers: {} // { playerId: wager }
};

// --- Game Data (Copied from your client-side, now authoritative on server) ---
const PLAYER_COLORS = ['#4caf50', '#2196f3', '#ff9800', '#e91e63', '#9c27b0', '#00bcd4', '#f44336', '#ffc107'];
const MIN_WAGER = 5;
const DAILY_DOUBLE_MAX_WAGER_BASE = 1000;

const gameData = {
    categories: [
        { name: 'Food Safety', clues: [200, 400, 600, 800, 1000] },
        { name: 'GMPs', clues: [200, 400, 600, 800, 1000] },
        { name: 'FSMA', clues: [200, 400, 600, 800, 1000] },
        { name: 'Allergens', clues: [200, 400, 600, 800, 1000] },
        { name: 'HACCP', clues: [200, 400, 600, 800, 1000] },
        { name: 'Chocolate', clues: [200, 400, 600, 800, 1000] }
    ]
};
const questionBank = {
    'Food Safety': [
        'The temperature danger zone for potentially hazardous foods is generally recognized as being between 41°F and what upper temperature? (A: 135°F)',
        'This common practice involves cooling cooked food rapidly through the temperature danger zone. (A: Two-stage cooling)',
        'What is the minimum internal cooking temperature required for poultry? (A: 165°F)',
        'Cross-contamination can be prevented by using separate cutting boards for raw meat and this type of food. (A: Ready-to-eat foods)',
        'The "Big 9" refers to the major food ________ recognized by the US FDA that must be declared on labels. (A: Allergens)',
    ],
    'GMPs': [
        'What does GMP stand for? (A: Good Manufacturing Practices)',
        'Employees must wash their _______ thoroughly before starting work, after using the restroom, and after handling raw materials. (A: Hands)',
        'This type of clothing, including hairnets and beard nets, must be worn to prevent physical contamination. (A: Protective clothing/uniforms/coverings)',
        'GMPs require maintaining clean and __________ facilities, including floors, walls, and equipment. (A: Sanitized)',
        'Proper storage practices under GMPs include keeping raw and cooked foods _________. (A: Separate)',
    ],
    'FSMA': [
        'FSMA, signed into law in 2011, stands for the Food Safety ____________ Act. (A: Modernization)',
        'This key rule under FSMA requires food facilities to develop and implement a written Food Safety Plan based on hazard analysis. (A: Preventive Controls for Human Food Rule)',
        'A PCQI is a Preventive Controls _________ Individual, required to oversee the Food Safety Plan. (A: Qualified)',
        'FSMA shifted the focus of food safety from responding to contamination to ___________ it. (A: Preventing)',
        'This FSMA rule focuses on ensuring the safety of fresh fruits and vegetables during growing, harvesting, packing, and holding. (A: Produce Safety Rule)',
    ],
    'Allergens': [
        'Besides Tree Nuts, Peanuts, Milk, Eggs, Soy, Wheat, Fish, and Crustacean Shellfish, what is the 9th major allergen added in 2023? (A: Sesame)',
        'FALCPA requires allergen declarations to be in clear, plain language, often using the word "Contains" followed by the allergen name(s). What does FALCPA stand for? (A: Food Allergen Labeling and Consumer Protection Act)',
        'An effective Allergen Control Plan includes preventing this, the unintentional incorporation of an allergen into a food. (A: Cross-contact)',
        'Cleaning procedures must be validated to ensure they effectively remove allergen ________ from shared equipment. (A: Residues)',
        '"May contain..." or "Processed in a facility that also handles..." are examples of what type of non-mandatory labeling? (A: Precautionary Allergen Labeling / PAL / Advisory Statements)',
    ],
    'HACCP': [
        'What does HACCP stand for? (A: Hazard Analysis and Critical Control Point)',
        'How many principles are there in a HACCP system? (A: Seven)',
        'Principle 1 involves conducting a ________ analysis to identify potential biological, chemical, or physical risks. (A: Hazard)',
        'A point in the process where control can be applied and is essential to prevent or eliminate a food safety hazard is called a ______. (A: Critical Control Point / CCP)',
        'Establishing critical limits, monitoring procedures, corrective actions, verification, and record-keeping are the remaining principles after Hazard Analysis and determining CCPs. Which principle involves defining the maximum or minimum value a CCP must meet? (A: Establishing Critical Limits)',
    ],
    'Chocolate': [
        'Chocolate liquor, cocoa butter, and sugar are the main ingredients in this type of chocolate. (A: Dark Chocolate)',
        'This process involves heating and cooling chocolate to specific temperatures to stabilize the cocoa butter crystals, giving it a smooth texture and sheen. (A: Tempering)',
        'Originating from the beans of the Theobroma cacao tree, chocolate production primarily occurs in regions near this imaginary line circling the Earth. (A: Equator)',
        'The "bloom" seen on old chocolate is often caused by migration of either fat or ______ to the surface. (A: Sugar)',
        'This type of chocolate contains milk solids and typically has a milder flavor than dark chocolate. (A: Milk Chocolate)',
    ]
};
const finalJeopardyQuestions = [
    { category: "Food Safety Final", question: "This federal agency is primarily responsible for regulating meat, poultry, and processed egg products in the US.", answer: "USDA-FSIS" },
    { category: "GMP Final", question: "What does the acronym 'PIC' often stand for in the context of food safety management?", answer: "Person In Charge" },
    { category: "FSMA Final", question: "This FSMA rule requires domestic and foreign facilities to establish and implement a food defense plan.", answer: "Mitigation Strategies to Protect Food Against Intentional Adulteration or 'Food Defense Rule'" }
];
const numCategories = gameData.categories.length;
const numCluesPerCat = gameData.categories[0]?.clues?.length ?? 0;
const totalClues = numCategories * numCluesPerCat;


// --- Helper Functions (Server-Side) ---

// Sends a simplified game state to all connected clients
function broadcastGameState() {
    io.emit('gameStateUpdate', {
        gameStarted: game.gameStarted,
        players: game.players.map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color, socketId: p.socketId })), // Include socketId for client to identify itself
        currentPlayerId: game.currentPlayerId,
        boardState: game.boardState,
        activeCardKey: game.activeCardKey,
        currentQuestionText: game.currentQuestionText,
        currentWager: game.currentWager,
        currentBuzzerPlayerId: game.currentBuzzerPlayerId, // Who has buzzed in
        historyStackLength: game.historyStack.length, // For client to know undo state
        answeredCluesCount: game.answeredCluesCount,
        turnCounter: game.turnCounter,
        scoreHistory: game.scoreHistory, // Send for chart
        finalJeopardyData: game.finalJeopardyData ? { category: game.finalJeopardyData.category, question: game.finalJeopardyData.question } : null
    });
}

// Determines and places Daily Doubles on the board
function determineDailyDoubleLogic() {
    // Reset any existing DDs
    Object.keys(game.boardState).forEach(key => {
        if (game.boardState[key]) game.boardState[key].isDailyDouble = false;
    });

    const potentialLocations = [];
    for (let r = 1; r < numCluesPerCat; r++) { // Clues from value 200 up (index 1) are eligible
        for (let c = 0; c < numCategories; c++) {
            const k = `${c}-${r}`;
            // Only consider cards not yet answered or failed by anyone
            // Ensure boardState[k] exists before accessing its properties
            if (!game.boardState[k] || (!game.boardState[k].state && (!game.boardState[k].failedPlayerIds || game.boardState[k].failedPlayerIds.length === 0))) {
                potentialLocations.push(k);
            }
        }
    }

    if (potentialLocations.length > 0) {
        // Place DD1
        const dd1Index = Math.floor(Math.random() * potentialLocations.length);
        const dd1Key = potentialLocations.splice(dd1Index, 1)[0];
        if (!game.boardState[dd1Key]) game.boardState[dd1Key] = {};
        game.boardState[dd1Key].isDailyDouble = true;
        console.log("Server DD1 location:", dd1Key);

        // Place DD2 if conditions met (e.g., enough categories/clues and still locations left)
        if (numCategories >= 5 && numCluesPerCat >= 3 && potentialLocations.length > 0) {
            const dd2Index = Math.floor(Math.random() * potentialLocations.length);
            const dd2Key = potentialLocations[dd2Index];
            if (!game.boardState[dd2Key]) game.boardState[dd2Key] = {};
            game.boardState[dd2Key].isDailyDouble = true;
            console.log("Server DD2 location:", dd2Key);
        }
    } else {
        console.log("Server: Could not place Daily Double(s) - no eligible locations.");
    }
}

// Resets board state for a new game or specific questions
function resetBoardState() {
    game.boardState = {};
    for (let r = 0; r < numCluesPerCat; r++) {
        for (let c = 0; c < numCategories; c++) {
            const key = `${c}-${r}`;
            game.boardState[key] = {
                state: null, // null, 'correct', 'wrong'
                playerId: null, // who answered correctly
                failedPlayerIds: [], // players who failed this question
                isDailyDouble: false
            };
        }
    }
}

// Advances to the next player's turn to pick a question
function nextPlayerTurnToPick() {
    if (game.players.length <= 1) {
        game.currentPlayerId = null; // No one to pick if less than 1 player
        return;
    }
    let currentIndex = game.players.findIndex(p => p.id === game.currentPlayerId);
    if (currentIndex === -1) currentIndex = 0; // If current player not found, start with first
    currentIndex = (currentIndex + 1) % game.players.length;
    game.currentPlayerId = game.players[currentIndex].id;
    game.turnCounter++; // A new turn begins when a player gets to pick
    console.log(`Server: New picking turn for ${game.players[currentIndex].name}`);
    broadcastGameState();
}


// --- Socket.IO Event Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send current game state to newly connected client to sync them up
    broadcastGameState();

    // Client provides a display name when they connect
    socket.on('playerConnect', (playerName) => {
        // Here, we associate the current socket.id with the player name.
        // This is important for identifying the client later.
        let existingPlayer = game.players.find(p => p.name === playerName);
        if (existingPlayer) {
            existingPlayer.socketId = socket.id; // Update socketId if player reconnects
            console.log(`Server: Existing player '${playerName}' reconnected with socket ID ${socket.id}`);
        } else {
            // This event is primarily for setting up the client's identity for display purposes.
            // Actual game player addition happens via 'addPlayer'
            console.log(`Server: Socket ${socket.id} identifies as: ${playerName}`);
        }
        broadcastGameState(); // Update all clients with latest player socket IDs
    });

    // --- Host-only actions (for simplicity, any client can trigger these now) ---
    socket.on('addPlayer', (playerName) => {
        if (game.players.length >= PLAYER_COLORS.length) {
            socket.emit('alert', "Maximum number of players reached.");
            return;
        }
        // Generate a persistent player ID (not transient socket.id)
        const id = 'player-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        const newPlayer = {
            id,
            name: playerName,
            score: 0,
            color: PLAYER_COLORS[game.players.length % PLAYER_COLORS.length],
            socketId: id // This will be updated with actual socket.id on playerConnect
        };
        game.players.push(newPlayer);
        game.scoreHistory[id] = [{ turn: 0, score: 0 }];
        console.log("Server: Player added:", newPlayer.name, "with ID:", newPlayer.id);
        broadcastGameState();
    });

    socket.on('startGame', () => {
        if (game.players.length === 0) {
            socket.emit('alert', "Please add at least one player to start.");
            return;
        }
        game.gameStarted = true;
        game.currentPlayerId = game.players[0].id; // First player picks first
        game.currentBuzzerPlayerId = null;
        game.activeCardKey = null;
        game.currentQuestionText = null;
        game.currentWager = 0;
        game.answeredCluesCount = 0;
        game.turnCounter = 0;
        game.historyStack = [];
        game.scoreHistory = {}; // Reset score history for new game
        game.players.forEach(p => { p.score = 0; game.scoreHistory[p.id] = [{ turn: 0, score: 0 }]; });
        resetBoardState(); // Initialize empty board
        determineDailyDoubleLogic(); // Place DDs
        console.log("Server: Game started by host.");
        io.emit('playMusic'); // Tell clients to play music
        broadcastGameState();
    });

    // Host manually sets active player
    socket.on('manualSetActivePlayer', (playerId) => {
        const player = game.players.find(p => p.id === playerId);
        if (player && game.gameStarted && !game.activeCardKey) { // Can only change if no question active
            const previousPlayerId = game.currentPlayerId;
            game.currentPlayerId = playerId;
            if (previousPlayerId !== playerId) {
                game.turnCounter++; // Increment turn if host explicitly changes to a different player
                console.log(`Server: Host set active player to ${player.name}. Turn: ${game.turnCounter}`);
            } else {
                console.log(`Server: Host confirmed active player as ${player.name}.`);
            }
            broadcastGameState();
        } else {
            socket.emit('alert', 'Cannot change active player right now.');
        }
    });

    socket.on('manualScoreUpdate', (playerId, targetScore) => {
        const player = game.players.find(p => p.id === playerId);
        if (player) {
            const delta = targetScore - player.score;
            player.score += delta;
            game.historyStack.push({ action: 'score', playerId: playerId, delta: delta, turn: game.turnCounter, cardKey: 'manual_update' });
            if (!game.scoreHistory[playerId]) game.scoreHistory[playerId] = [];
            game.scoreHistory[playerId].push({ turn: game.turnCounter, score: player.score });
            game.turnCounter++; // Manual update also advances turn counter
            broadcastGameState();
        }
    });

    socket.on('undoLastAction', () => {
        const lastAction = game.historyStack.pop();
        if (!lastAction) {
            socket.emit('alert', "No actions to undo.");
            broadcastGameState(); // Still broadcast to update undo button state
            return;
        }
        console.log("Server: Undoing:", lastAction);

        const player = game.players.find(p => p.id === lastAction.playerId);
        if (player) {
            player.score -= lastAction.delta;
            if (game.scoreHistory[lastAction.playerId]) {
                game.scoreHistory[lastAction.playerId].pop(); // Remove last score entry
                if (game.scoreHistory[lastAction.playerId].length === 0) {
                    game.scoreHistory[lastAction.playerId].push({ turn: 0, score: 0 }); // Ensure a zero score if empty
                }
            }
        }

        if (lastAction.cardKey && lastAction.cardKey !== 'manual_update' && lastAction.cardKey !== 'final_jeopardy') {
            const cardState = game.boardState[lastAction.cardKey];
            if (cardState) {
                const wasCorrectOrWrong = cardState.state === 'correct' || cardState.state === 'wrong';
                cardState.state = null; // Card is now open again
                cardState.playerId = null; // Clear who answered
                if (cardState.failedPlayerIds) { // Remove player from failed list if they failed it
                    const fIdx = cardState.failedPlayerIds.indexOf(lastAction.playerId);
                    if (fIdx > -1) cardState.failedPlayerIds.splice(fIdx, 1);
                }
                if (wasCorrectOrWrong) game.answeredCluesCount--; // Decrement if it was a resolved card
                game.activeCardKey = null; // No active card after undo
                game.currentQuestionText = null;
                game.currentWager = 0;
                game.currentBuzzerPlayerId = null; // No one has buzzer
                io.emit('hideQuestionDisplay');
            }
        }
        broadcastGameState();
    });

    socket.on('resetScores', () => {
        game.players.forEach(p => { p.score = 0; game.scoreHistory[p.id] = [{ turn: 0, score: 0 }]; });
        game.historyStack = [];
        game.turnCounter = 0;
        broadcastGameState();
        socket.emit('alert', "All player scores have been reset to $0.");
    });

    socket.on('newGame', () => {
        // Reset full game state
        game = {
            gameStarted: false,
            players: [], // Reset players too for a truly new game (clients will re-add themselves)
            currentPlayerId: null,
            currentBuzzerPlayerId: null,
            boardState: {},
            activeCardKey: null,
            currentQuestionText: null,
            currentWager: 0,
            historyStack: [],
            scoreHistory: {},
            answeredCluesCount: 0,
            turnCounter: 0,
            finalJeopardyData: null,
            finalJeopardyWagers: {}
        };
        io.emit('stopMusic');
        broadcastGameState();
        socket.emit('alert', "New game started. Please add players.");
    });

    // --- Player actions ---
    socket.on('selectCard', (stateKey) => {
        const player = game.players.find(p => p.socketId === socket.id);
        if (!player || player.id !== game.currentPlayerId) {
            socket.emit('alert', "It's not your turn to select a question!");
            return;
        }

        const cardState = game.boardState[stateKey];
        if (!cardState || cardState.state === 'correct' || cardState.state === 'wrong') {
            socket.emit('alert', "This card has already been answered.");
            return;
        }

        game.activeCardKey = stateKey;
        const [catIndex, rowIndex] = stateKey.split('-').map(Number);
        const categoryName = gameData.categories[catIndex]?.name;
        const fullQuestionText = questionBank[categoryName]?.[rowIndex];
        const value = gameData.categories[catIndex]?.clues[rowIndex];

        let displayQuestion = fullQuestionText;
        const answerStartIndex = fullQuestionText.indexOf('(A:');
        if (answerStartIndex !== -1) {
            displayQuestion = fullQuestionText.substring(0, answerStartIndex).trim();
        }

        game.currentQuestionText = displayQuestion;
        game.currentWager = value; // Default wager, can be overridden for DD

        if (cardState.isDailyDouble) {
            io.to(socket.id).emit('prompt', { message: `DAILY DOUBLE!\n${player.name}, enter your wager (min $${MIN_WAGER}, max $${Math.max(DAILY_DOUBLE_MAX_WAGER_BASE, player.score > 0 ? player.score : DAILY_DOUBLE_MAX_WAGER_BASE)}):` }, (wagerInput) => {
                let wager = parseInt(wagerInput, 10);
                const maxW = Math.max(DAILY_DOUBLE_MAX_WAGER_BASE, player.score > 0 ? player.score : DAILY_DOUBLE_MAX_WAGER_BASE);

                if (isNaN(wager) || wager < MIN_WAGER || wager > maxW) {
                    io.to(socket.id).emit('alert', `Invalid wager. Wager defaulted to $${MIN_WAGER}.`);
                    wager = MIN_WAGER;
                }
                game.currentWager = wager;
                io.emit('dailyDoubleSound');
                io.emit('questionDisplayed', game.currentQuestionText, game.activeCardKey);
                io.emit('stopMusic');
                game.currentBuzzerPlayerId = null; // Open buzzer for all players
                broadcastGameState(); // State update after wager
            });
        } else {
            io.emit('questionDisplayed', game.currentQuestionText, game.activeCardKey);
            io.emit('stopMusic');
            game.currentBuzzerPlayerId = null; // Open buzzer for all players
            broadcastGameState(); // State update for regular question
        }
    });

    // Player buzzes in
    let buzzerLock = false; // Simple lock to prevent multiple simultaneous buzzes
    socket.on('buzz', () => {
        if (buzzerLock || game.activeCardKey === null || game.currentBuzzerPlayerId !== null) {
            // Already buzzed in or buzzer not open
            return;
        }
        const playerBuzzer = game.players.find(p => p.socketId === socket.id);
        if (!playerBuzzer) return;

        const cardState = game.boardState[game.activeCardKey];
        if (cardState && cardState.failedPlayerIds.includes(playerBuzzer.id)) {
            io.to(socket.id).emit('alert', `You have already failed this question!`);
            return;
        }

        buzzerLock = true; // Lock the buzzer for a moment (server-side arbitration)
        game.currentBuzzerPlayerId = playerBuzzer.id; // Assign buzzer to this player
        console.log(`Server: ${playerBuzzer.name} buzzed in!`);
        io.emit('buzzerSound'); // Play a generic buzzer sound on all clients
        io.emit('buzzerActive', playerBuzzer.id); // Tell clients who buzzed in

        // Host controls for judging appear on clients.
        io.emit('showJudgeControls', game.activeCardKey, playerBuzzer.id);
        broadcastGameState();

        // Release lock after a short delay to prevent spamming
        setTimeout(() => {
            buzzerLock = false;
        }, 500); // 500ms debounce for buzzer
    });

    // Host judges an answer
    socket.on('judgeAnswer', (cardKey, isCorrect, buzzedPlayerId) => {
        // Ensure this is the currently active card and the player who buzzed in
        if (cardKey !== game.activeCardKey || buzzedPlayerId !== game.currentBuzzerPlayerId) {
            console.warn("Server: Attempt to judge non-active or wrong player/card.");
            return;
        }

        const player = game.players.find(p => p.id === buzzedPlayerId);
        if (!player) return;

        const delta = isCorrect ? game.currentWager : -game.currentWager;
        player.score += delta;
        game.historyStack.push({ action: 'score', playerId: buzzedPlayerId, delta: delta, turn: game.turnCounter, cardKey: cardKey });
        game.scoreHistory[buzzedPlayerId].push({ turn: game.turnCounter, score: player.score });
        game.turnCounter++;

        io.emit(isCorrect ? 'correctSound' : 'wrongSound');
        io.emit('hideJudgeControls');
        io.emit('hideQuestionDisplay');

        if (isCorrect) {
            game.boardState[cardKey].state = 'correct';
            game.boardState[cardKey].playerId = buzzedPlayerId;
            game.answeredCluesCount++;
            game.activeCardKey = null;
            game.currentQuestionText = null;
            game.currentWager = 0;
            game.currentBuzzerPlayerId = null; // Clear buzzer state

            if (game.answeredCluesCount >= totalClues) {
                io.emit('finalJeopardySetup');
            } else {
                game.currentPlayerId = buzzedPlayerId; // Correct player picks next question
            }
        } else {
            // Incorrect answer
            if (!game.boardState[cardKey].failedPlayerIds) {
                game.boardState[cardKey].failedPlayerIds = [];
            }
            if (!game.boardState[cardKey].failedPlayerIds.includes(buzzedPlayerId)) {
                game.boardState[cardKey].failedPlayerIds.push(buzzedPlayerId);
            }

            const eligibleCount = game.players.filter(p => !game.boardState[cardKey].failedPlayerIds.includes(p.id)).length;

            if (game.boardState[cardKey].isDailyDouble || eligibleCount === 0) {
                // Daily Double was incorrect, or all players failed this question
                game.boardState[cardKey].state = 'wrong';
                game.answeredCluesCount++;
                game.activeCardKey = null;
                game.currentQuestionText = null;
                game.currentWager = 0;
                game.currentBuzzerPlayerId = null; // Clear buzzer state

                if (game.answeredCluesCount >= totalClues) {
                    io.emit('finalJeopardySetup');
                } else {
                    nextPlayerTurnToPick(); // Next player gets to pick
                }
            } else {
                // Question is still open for other players to steal
                game.currentBuzzerPlayerId = null; // Clear buzzer, open for new buzz
            }
        }
        broadcastGameState();
    });

    socket.on('noOtherTakers', (cardKey) => {
        if (cardKey !== game.activeCardKey) return; // Only process for the currently active card

        game.boardState[cardKey].state = 'wrong';
        game.answeredCluesCount++;
        game.activeCardKey = null;
        game.currentQuestionText = null;
        game.currentWager = 0;
        game.currentBuzzerPlayerId = null;
        io.emit('hideJudgeControls');
        io.emit('hideQuestionDisplay');

        if (game.answeredCluesCount >= totalClues) {
            io.emit('finalJeopardySetup');
        } else {
            nextPlayerTurnToPick();
        }
        broadcastGameState();
    });

    // --- Final Jeopardy Server Logic ---
    socket.on('revealFinalQuestion', () => {
        // Ensure only eligible players exist and random FJ question is chosen
        const eligiblePlayers = game.players.filter(p => p.score > 0);
        if (eligiblePlayers.length === 0) {
            socket.emit('alert', "No players have a positive score eligible for Final Jeopardy!");
            io.emit('showFinalResults', game.players.map(p => ({ id: p.id, name: p.name, score: p.score })));
            return;
        }
        game.finalJeopardyData = finalJeopardyQuestions[Math.floor(Math.random() * finalJeopardyQuestions.length)];
        game.finalJeopardyWagers = {}; // Reset wagers

        io.emit('stopMusic'); // Stop background music for all
        io.emit('finalJeopardySound'); // Play FJ sound for all

        io.emit('finalQuestionRevealed', {
            category: game.finalJeopardyData.category,
            question: game.finalJeopardyData.question,
            players: eligiblePlayers.map(p => ({ id: p.id, name: p.name, score: p.score }))
        });
        broadcastGameState(); // To update client state for FJ start
    });

    socket.on('submitFinalWagers', (wagers) => {
        // Collect wagers from all clients. This assumes client sends only its own wager.
        for (const playerId in wagers) {
            game.finalJeopardyWagers[playerId] = wagers[playerId];
        }

        // Check if all eligible players have submitted wagers
        const eligiblePlayerIds = game.players.filter(p => p.score > 0).map(p => p.id);
        const submittedWagerIds = Object.keys(game.finalJeopardyWagers);

        const allWagersSubmitted = eligiblePlayerIds.every(id => submittedWagerIds.includes(id));

        if (allWagersSubmitted) {
            io.emit('wagersLockedIn');
            broadcastGameState(); // Update state to show wagers locked
        } else {
            // Optionally, you could broadcast current wager status for host to see who hasn't submitted
            console.log("Server: Not all wagers submitted yet.", { submitted: submittedWagerIds, eligible: eligiblePlayerIds });
            broadcastGameState(); // Keep state updated for partial submissions
        }
    });

    socket.on('judgeFinalAnswers', (results) => {
        results.forEach(res => {
            const player = game.players.find(p => p.id === res.playerId);
            const wager = game.finalJeopardyWagers[res.playerId];
            if (player && wager !== undefined) {
                const delta = res.isCorrect ? wager : -wager;
                player.score += delta;
                game.historyStack.push({ action: 'score', playerId: player.id, delta: delta, turn: game.turnCounter, cardKey: 'final_jeopardy' });
                if (!game.scoreHistory[player.id]) game.scoreHistory[player.id] = [];
                game.scoreHistory[player.id].push({ turn: game.turnCounter, score: player.score });
            }
        });
        game.turnCounter++; // Increment turn for FJ judging

        io.emit('finalJeopardyAnswerRevealed', game.finalJeopardyData.answer); // Reveal answer to clients
        broadcastGameState(); // Update scores before showing results

        setTimeout(() => {
            io.emit('showFinalResults', game.players.map(p => ({ id: p.id, name: p.name, score: p.score })));
            game.finalJeopardyData = null; // Clear FJ state
            game.finalJeopardyWagers = {};
            // Game state is now effectively "over" or awaiting new game
            broadcastGameState(); // To reset client UI away from FJ
        }, 3000); // Delay for viewing answer
    });


    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // In a real application, you might update player.socketId = null or remove players entirely
        // For this example, we keep players in the list but their socketId might become stale if they truly leave.
        // It's better to update the player object to reflect disconnection if needed for specific UI.
        // For simplicity, we just log.
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
```