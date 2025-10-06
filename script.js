// Cache Control: no-cache
// AI Configuration
const STRAT_RANDOM = 0.1; // 10% randomization threshold for AI strategy decisions
const BOARD_SIZE = 11; // 11x11 hexagonal board

// Game state
let gameState = {
    currentPlayer: 1,
    phase: 'setup', // setup, play, end
    turn: 1,
    board: Array(11).fill().map(() => Array(11).fill(null)), // Changed to 11x11 (removed first row and last column)
    players: {
        1: {
            hand: [],
            captured: [],
            discarded: [],
            deck: [],
            leader: null,
            leaderPosition: null
        },
        2: {
            hand: [],
            captured: [],
            discarded: [],
            deck: [],
            leader: null,
            leaderPosition: null
        }
    },
    selectedCard: null,
    selectedHex: null,
    selectedCards: [], // Multiple cards for combined attacks
    validMoves: [],
    validAttacks: [],
    blockedMoves: [],
    absorptions: [], // Track spade absorptions for visual feedback
    setupStep: 'place-cards', // place-cards, discard (no separate leader step)
    setupCardsPlaced: { 1: 0, 2: 0 },
    setupLeaderPlaced: { 1: false, 2: false }, // Track if leader is placed
    leaderAttackedThisTurn: false,
    cardsMovedThisTurn: new Set(),
    cardsAttackedThisTurn: new Set(),
    cardsAttackExhaustion: new Map(), // Maps card.id -> turn number when attack exhaustion ends
    moveCount: 1, // Track total moves for aggressor rule
    firstPlayer: 1 // Track who had the first turn (aggressor)
};

// Fade-out animation state (now using DOM elements)
let fadeOutElements = []; // Array of DOM elements being animated

// Game history for undo functionality
let gameHistory = [];
const MAX_HISTORY_SIZE = 10; // Keep last 10 states

// AI Thinking Indicator State
let aiThinkingState = {
    isThinking: false,
    player: null,
    phase: '',
    progress: 0,
    maxProgress: 100,
    currentAction: '',
    startTime: null,
    thinkingDots: 0
};

// Canvas and rendering
let canvas;
let ctx;
let hexSize = 22; // Smaller hexes to fit cards perfectly
let baseHexSize = 22; // Base size for zoom calculations
let zoomLevel = 1.0; // Current zoom level
let hexWidth;
let hexHeight;
let boardOffsetX;
let boardOffsetY;
let mapRotated = false; // false = Player 1's perspective, true = Player 2's perspective
let mapFlippingEnabled = true; // Toggle for automatic map flipping on player switch (auto-managed based on AI)
let aiEnabled = { 1: false, 2: true }; // Track which players are AI controlled - Default: P1 human vs P2 AI



// AI face down card helper
function getCardForAI(card, aiPlayer) {
    // AI can only see face up cards of enemies
    if (card.faceDown && card.owner !== aiPlayer) {
        // Return a generic face down card representation for AI
        // Assume face-down cards are moderate threats that should be revealed
        return {
            ...card,
            value: '?',
            suit: 'unknown',
            attack: 3, // Assume higher attack to encourage proactive elimination
            defense: 3, // Assume higher defense to encourage combined attacks
            isAIHidden: true
        };
    }
    return card; // AI can see its own cards and face up enemy cards
}

// AI Aggression System
const BASE_AGG = 70; // Base aggression level (0-100 scale)
const EXTRA_AGG = 30; // Random extra aggression (0-50)
let aiAggression = { 1: 0, 2: 0 }; // Aggression level for each player (0-100)

// Initialize AI aggression levels at game start
function initializeAIAggression() {
    for (let player = 1; player <= 2; player++) {
        if (aiEnabled[player]) {
            const randomExtra = Math.floor(Math.random() * (EXTRA_AGG + 1)); // 0 to EXTRA_AGG
            aiAggression[player] = BASE_AGG + randomExtra;
            console.log(`AI Player ${player} aggression level: ${aiAggression[player]}/100 (Base: ${BASE_AGG}, Extra: ${randomExtra})`);
        } else {
            aiAggression[player] = 0; // Human players have no aggression modifier
        }
    }
}

// Get aggression modifier for scoring (0.5 to 2.0 multiplier)
function getAggressionModifier(player) {
    if (!aiEnabled[player]) return 1.0;
    
    const aggLevel = aiAggression[player];
    // Convert 0-100 aggression to 0.5-2.0 multiplier
    // 0 aggression = 0.5x, 50 aggression = 1.0x, 100 aggression = 2.0x
    return 0.5 + (aggLevel / 100) * 1.5;
}

// Check if any AI players are enabled
function hasAnyAI() {
    return aiEnabled[1] || aiEnabled[2];
}

// Check if both players are AI (Bot vs Bot mode)
function isBotVsBot() {
    return aiEnabled[1] && aiEnabled[2];
}

// Screen Wake Lock Management for AI vs AI mode
let wakeLock = null;
let wakeLockSupported = 'wakeLock' in navigator;

async function requestWakeLock() {
    if (!wakeLockSupported) {
        console.log('Wake Lock API not supported, using fallback methods');
        return false;
    }
    
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        console.log('Screen wake lock activated for AI vs AI mode');
        
        wakeLock.addEventListener('release', () => {
            console.log('Screen wake lock released');
        });
        
        return true;
    } catch (err) {
        console.error('Failed to request wake lock:', err);
        return false;
    }
}

async function releaseWakeLock() {
    if (wakeLock) {
        try {
            await wakeLock.release();
            wakeLock = null;
            console.log('Screen wake lock manually released');
        } catch (err) {
            console.error('Failed to release wake lock:', err);
        }
    }
}

// Fallback method for keeping screen awake (for browsers without Wake Lock API)
let keepAliveInterval = null;

function startKeepAlive() {
    if (keepAliveInterval) return;
    
    // Create a tiny invisible video to keep screen active
    const video = document.createElement('video');
    video.style.position = 'absolute';
    video.style.top = '-1px';
    video.style.left = '-1px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0.01';
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.id = 'keepAliveVideo';
    
    // Create a minimal video source (1x1 pixel, 1 second duration)
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 1, 1);
    
    canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        video.src = url;
        document.body.appendChild(video);
        
        video.play().catch(e => console.log('Fallback keep-alive video failed:', e));
    });
    
    // Additional fallback: periodic no-op to prevent sleep
    keepAliveInterval = setInterval(() => {
        // Trigger a minimal DOM operation to show activity
        document.body.style.background = document.body.style.background;
    }, 30000); // Every 30 seconds
    
    console.log('Started fallback keep-alive methods');
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
    
    const video = document.getElementById('keepAliveVideo');
    if (video) {
        video.remove();
    }
    
    console.log('Stopped fallback keep-alive methods');
}

// Main function to manage screen wake lock based on AI mode
async function updateScreenWakeLock() {
    if (isBotVsBot() && gameState.phase === 'play') {
        // AI vs AI in play mode - keep screen awake
        if (!wakeLock) {
            const success = await requestWakeLock();
            if (!success) {
                // Fallback for browsers without Wake Lock API
                startKeepAlive();
            }
        }
    } else {
        // Not AI vs AI or not in play mode - release wake lock
        await releaseWakeLock();
        stopKeepAlive();
    }
}

// Update map flipping based on AI presence
function updateMapFlippingForAI() {
    // Map flipping logic:
    // - No AI: map flips with turns (human vs human)  
    // - One AI: map stays locked to human player's perspective (human vs AI)
    // - Two AI: map stays locked to Player 1's perspective (AI vs AI spectating)
    const aiCount = (aiEnabled[1] ? 1 : 0) + (aiEnabled[2] ? 1 : 0);
    mapFlippingEnabled = (aiCount === 0); // Only enable flipping for human vs human
    
    if (!mapFlippingEnabled) {
        if (aiCount === 1) {
            // Human vs AI: show from human player's perspective
            const humanPlayer = aiEnabled[1] ? 2 : 1; // If player 1 is AI, then human is player 2
            mapRotated = (humanPlayer === 1); // Human player 1 sees map normally, player 2 sees flipped
        } else {
            // AI vs AI: always show from Player 1's perspective for consistent spectating
            mapRotated = true; // Player 1 perspective (A1 B1 at bottom)
        }
    } else {
        // Update rotation for current player when enabling (human vs human only)
        updateMapRotation();
    }
    
    updateCanvas();
    if (mapFlippingEnabled) {
        console.log(`Map flipping enabled - map rotates based on current player (human vs human)`);
    } else {
        if (aiCount === 1) {
            const humanPlayer = aiEnabled[1] ? 2 : 1;
            console.log(`Map flipping disabled - map locked to human player ${humanPlayer}'s perspective (human vs AI)`);
        } else {
            console.log(`Map flipping disabled - map locked to Player 1's perspective (AI vs AI spectating)`);
        }
    }
}

// Set map rotation based on current player in both Setup and Play modes
function updateMapRotation() {
    if (mapFlippingEnabled) {
        if (gameState.phase === 'play') {
            // In Play mode, orient map from active player's perspective (if enabled)
            // Player 1 sees A1 B1 at bottom (mapRotated = true to flip from default)
            // Player 2 sees A1 B1 at top (mapRotated = false for default view)
            mapRotated = (gameState.currentPlayer === 1);
        } else if (gameState.phase === 'setup') {
            // In Setup mode, also orient map from active player's perspective (if enabled)
            // Player 1 sees A1 B1 at bottom (mapRotated = true to flip from default)
            // Player 2 sees A1 B1 at top (mapRotated = false for default view)
            mapRotated = (gameState.currentPlayer === 1);
        }
    } else {
        // If map flipping is disabled (AI present), always show from Player 1's perspective
        // Player 1 perspective means A1 B1 at bottom (mapRotated = true to flip from default)
        mapRotated = true;
    }
}

function toggleAIPlayer(player) {
    aiEnabled[player] = !aiEnabled[player];
    
    // Automatically update map flipping based on AI presence
    updateMapFlippingForAI();
    
    // Update screen wake lock for AI vs AI mode
    updateScreenWakeLock();
    
    // Update all AI button texts (both need to show map rotation status)
    updateAllAIButtons();
    
    // Save the setting
    saveGameState();
    
    console.log(`Player ${player} AI ${aiEnabled[player] ? 'enabled' : 'disabled'}`);
    
    // If it's currently the AI player's turn, trigger AI move
    if (aiEnabled[player] && gameState.currentPlayer === player && gameState.phase === 'play') {
        setTimeout(() => {
            performAIMove(player);
        }, 300); // Small delay for better UX
    }
}

function updateAIButton(player) {
    const btn = document.getElementById(`ai-p${player}-toggle-btn`);
    if (btn) {
        const aiStatus = aiEnabled[player] ? 'ON' : 'OFF';
        const mapStatus = hasAnyAI() ? ' 🔒' : ' 🔄'; // Lock icon when AI present, rotation icon when absent
        btn.textContent = `🤖 P${player} AI: ${aiStatus}${mapStatus}`;
    }
}

function updateAllAIButtons() {
    updateAIButton(1);
    updateAIButton(2);
}

function performAIMove(player) {
    console.log(`performAIMove called for player ${player}`);
    if (!aiEnabled[player] || gameState.currentPlayer !== player || gameState.phase !== 'play') {
        console.log(`AI Move cancelled: aiEnabled=${aiEnabled[player]}, currentPlayer=${gameState.currentPlayer}, phase=${gameState.phase}`);
        return;
    }

    // Don't act if user is currently dragging or has cards selected
    if (isDraggingCard || gameState.selectedCard || (gameState.selectedCards && gameState.selectedCards.length > 0)) {
        console.log(`AI waiting for user interaction to finish...`);
        setTimeout(() => performAIMove(player), 300); // Try again later
        return;
    }

    console.log(`AI Player ${player} starting turn ${gameState.turn}...`);
    
    // Start thinking indicator
    startAIThinking(player, 'play', 6);
    
    // Set emergency timeout to prevent AI from getting stuck
    if (aiTurnTimeout) {
        clearTimeout(aiTurnTimeout);
    }
    aiTurnTimeout = setTimeout(() => {
        console.log(`Emergency timeout: AI Player ${player} taking too long, forcing end turn`);
        const turnKey = `${player}-${gameState.turn}`;
        aiActionCount.delete(turnKey);
        endTurn();
    }, 30000); // 30 second emergency timeout
    
    performAITurnSequence(player);
}

// Track AI actions to prevent infinite loops
let aiActionCount = new Map();
let aiTurnTimeout = null;
let lastAIAction = null;

// AI Thinking Indicator Functions
function startAIThinking(player, phase, maxSteps = 5) {
    aiThinkingState = {
        isThinking: true,
        player: player,
        phase: phase,
        progress: 0,
        maxProgress: maxSteps,
        currentAction: 'Analyzing board...',
        startTime: Date.now(),
        thinkingDots: 0
    };
    updateAIThinkingDisplay();
}

function updateAIThinking(currentAction, progress = null) {
    if (aiThinkingState.isThinking) {
        aiThinkingState.currentAction = currentAction;
        if (progress !== null) {
            aiThinkingState.progress = Math.min(progress, aiThinkingState.maxProgress);
        }
        updateAIThinkingDisplay();
    }
}

function stopAIThinking() {
    aiThinkingState.isThinking = false;
    updateAIThinkingDisplay();
}

function updateAIThinkingDisplay() {
    if (aiThinkingState.isThinking) {
        // Update thinking dots animation
        aiThinkingState.thinkingDots = (aiThinkingState.thinkingDots + 1) % 4;
        
        // Update the display will be handled in updateUI()
        updateUI();
        
        // Schedule next update for animation
        setTimeout(() => {
            if (aiThinkingState.isThinking) {
                updateAIThinkingDisplay();
            }
        }, 500);
    }
}

// AI Randomization helpers
function shouldRandomizeStrategy() {
    return Math.random() < STRAT_RANDOM;
}

function addRandomNoise(score, maxNoise = 50) {
    // Add random noise to scores to create variation
    const noise = (Math.random() - 0.5) * 2 * maxNoise;
    return score + noise;
}

function shuffleArray(array) {
    // Fisher-Yates shuffle for randomizing action order
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function performAITurnSequence(player) {
    console.log(`performAITurnSequence called for player ${player}`);
    if (!aiEnabled[player] || gameState.currentPlayer !== player || gameState.phase !== 'play') {
        console.log(`AI Turn Sequence cancelled: aiEnabled=${aiEnabled[player]}, currentPlayer=${gameState.currentPlayer}, phase=${gameState.phase}`);
        return;
    }

    // Don't act if user is currently dragging or has cards selected
    if (isDraggingCard || gameState.selectedCard || (gameState.selectedCards && gameState.selectedCards.length > 0)) {
        console.log(`AI Turn Sequence waiting for user interaction to finish...`);
        setTimeout(() => performAITurnSequence(player), 300); // Try again later
        return;
    }

    // Initialize or get action count for this player's turn
    const turnKey = `${player}-${gameState.turn}`;
    if (!aiActionCount.has(turnKey)) {
        aiActionCount.set(turnKey, 0);
    }
    
    const actionsThisTurn = aiActionCount.get(turnKey);
    const maxActionsPerTurn = 20; // Allow more actions for aggressive play

    if (actionsThisTurn >= maxActionsPerTurn) {
        console.log(`AI Player ${player} reached max actions (${maxActionsPerTurn}), ending turn`);
        aiActionCount.delete(turnKey);
        setTimeout(() => endTurn(), 300);
        return;
    }

    // Check if we're approaching the 100-move limit
    const isNearMoveLimit = gameState.moveCount >= 80;
    const isAggressor = (player === gameState.firstPlayer);
    
    // Priority 0: LEADER PROTECTION - Highest priority!
    updateAIThinking('Checking leader safety...', 1);
    const leaderProtectionAction = findBestLeaderProtectionAction(player);
    if (leaderProtectionAction) {
        console.log(`[AI DEBUG] Leader protection needed! Type: ${leaderProtectionAction.type}, Priority: ${leaderProtectionAction.priority}`);
        
        if (leaderProtectionAction.type === 'move_leader') {
            const actionKey = `move-${leaderProtectionAction.fromRow}-${leaderProtectionAction.fromCol}-${leaderProtectionAction.toRow}-${leaderProtectionAction.toCol}`;
            
            if (lastAIAction !== actionKey) {
                updateAIThinking('Moving leader to safety!', 6);
                console.log(`AI Player ${player} moving leader to safety: (${leaderProtectionAction.fromRow},${leaderProtectionAction.fromCol}) -> (${leaderProtectionAction.toRow},${leaderProtectionAction.toCol})`);
                lastAIAction = actionKey;
                aiActionCount.set(turnKey, actionsThisTurn + 1);
                saveStateToHistory();
                moveCard(leaderProtectionAction.fromRow, leaderProtectionAction.fromCol, leaderProtectionAction.toRow, leaderProtectionAction.toCol);
                stopAIThinking();
                updateUI();
                setTimeout(() => performAITurnSequence(player), 200);
                return;
            }
        } else if (leaderProtectionAction.type === 'attack_threat') {
            const actionKey = `attack-${leaderProtectionAction.fromRow}-${leaderProtectionAction.fromCol}-${leaderProtectionAction.toRow}-${leaderProtectionAction.toCol}`;
            
            if (lastAIAction !== actionKey) {
                console.log(`AI Player ${player} attacking threat to leader: (${leaderProtectionAction.fromRow},${leaderProtectionAction.fromCol}) -> (${leaderProtectionAction.toRow},${leaderProtectionAction.toCol})`);
                lastAIAction = actionKey;
                aiActionCount.set(turnKey, actionsThisTurn + 1);
                saveStateToHistory();
                attack(leaderProtectionAction.fromRow, leaderProtectionAction.fromCol, leaderProtectionAction.toRow, leaderProtectionAction.toCol);
                updateUI();
                setTimeout(() => performAITurnSequence(player), 200);
                return;
            }
        } else if (leaderProtectionAction.type === 'combined_attack_threat') {
            const actionKey = `combined-attack-${leaderProtectionAction.target.row}-${leaderProtectionAction.target.col}`;
            
            if (lastAIAction !== actionKey) {
                updateAIThinking('Combined attack to protect leader!', 6);
                console.log(`AI Player ${player} using combined attack to eliminate leader threat at (${leaderProtectionAction.target.row},${leaderProtectionAction.target.col})`);
                lastAIAction = actionKey;
                aiActionCount.set(turnKey, actionsThisTurn + 1);
                saveStateToHistory();
                performAICombinedAttack(leaderProtectionAction.attackers, leaderProtectionAction.target.row, leaderProtectionAction.target.col);
                stopAIThinking();
                updateUI();
                setTimeout(() => performAITurnSequence(player), 200);
                return;
            }
        } else if (leaderProtectionAction.type === 'block_for_leader') {
            const actionKey = `move-${leaderProtectionAction.fromRow}-${leaderProtectionAction.fromCol}-${leaderProtectionAction.toRow}-${leaderProtectionAction.toCol}`;
            
            if (lastAIAction !== actionKey) {
                console.log(`AI Player ${player} moving card to block for leader: (${leaderProtectionAction.fromRow},${leaderProtectionAction.fromCol}) -> (${leaderProtectionAction.toRow},${leaderProtectionAction.toCol})`);
                lastAIAction = actionKey;
                aiActionCount.set(turnKey, actionsThisTurn + 1);
                saveStateToHistory();
                moveCard(leaderProtectionAction.fromRow, leaderProtectionAction.fromCol, leaderProtectionAction.toRow, leaderProtectionAction.toCol);
                updateUI();
                setTimeout(() => performAITurnSequence(player), 200);
                return;
            }
        } else if (leaderProtectionAction.type === 'eliminate_nearby_threat') {
            const actionKey = `eliminate-nearby-${leaderProtectionAction.fromRow}-${leaderProtectionAction.fromCol}-${leaderProtectionAction.toRow}-${leaderProtectionAction.toCol}`;
            
            if (lastAIAction !== actionKey) {
                updateAIThinking('Eliminating nearby threat to leader!', 6);
                console.log(`AI Player ${player} eliminating nearby threat to leader: (${leaderProtectionAction.fromRow},${leaderProtectionAction.fromCol}) -> (${leaderProtectionAction.toRow},${leaderProtectionAction.toCol})`);
                lastAIAction = actionKey;
                aiActionCount.set(turnKey, actionsThisTurn + 1);
                saveStateToHistory();
                attack(leaderProtectionAction.fromRow, leaderProtectionAction.fromCol, leaderProtectionAction.toRow, leaderProtectionAction.toCol);
                stopAIThinking();
                updateUI();
                setTimeout(() => performAITurnSequence(player), 200);
                return;
            }
        } else if (leaderProtectionAction.type === 'prevent_future_threat') {
            const actionKey = `prevent-future-${leaderProtectionAction.fromRow}-${leaderProtectionAction.fromCol}-${leaderProtectionAction.toRow}-${leaderProtectionAction.toCol}`;
            
            if (lastAIAction !== actionKey) {
                updateAIThinking('Preventing future threat to leader!', 6);
                console.log(`AI Player ${player} preventing future threat to leader: (${leaderProtectionAction.fromRow},${leaderProtectionAction.fromCol}) -> (${leaderProtectionAction.toRow},${leaderProtectionAction.toCol})`);
                lastAIAction = actionKey;
                aiActionCount.set(turnKey, actionsThisTurn + 1);
                saveStateToHistory();
                attack(leaderProtectionAction.fromRow, leaderProtectionAction.fromCol, leaderProtectionAction.toRow, leaderProtectionAction.toCol);
                stopAIThinking();
                updateUI();
                setTimeout(() => performAITurnSequence(player), 200);
                return;
            }
        }
    }
    
    // STRATEGIC RANDOMIZATION: Sometimes mix up priorities for unpredictable play
    const useRandomStrategy = shouldRandomizeStrategy();
    if (useRandomStrategy) {
        console.log(`[AI DEBUG] Player ${player} using randomized strategy this turn (${Math.floor(STRAT_RANDOM * 100)}% chance)`);
        
        // Sometimes skip summon to prioritize attacks (aggressive randomization)
        if (Math.random() < 0.3) {
            console.log(`[AI DEBUG] Random strategy: Skipping summon to prioritize attacks`);
            // Skip to combined/single attacks
            const randomCombinedAttack = findBestCombinedAttack(player, isNearMoveLimit, isAggressor);
            const randomSingleAttack = findBestAttackAction(player, isNearMoveLimit, isAggressor);
            
            if (randomCombinedAttack && randomSingleAttack) {
                // Randomly choose between combined and single attack
                const useCombined = Math.random() < 0.6; // Prefer combined attacks in random mode
                if (useCombined) {
                    const actionKey = `combined-attack-${randomCombinedAttack.target.row}-${randomCombinedAttack.target.col}-${randomCombinedAttack.combSize}`;
                    if (lastAIAction !== actionKey) {
                        console.log(`AI Player ${player} random combined attack: ${randomCombinedAttack.combSize} cards attacking ${randomCombinedAttack.target.card.value}${randomCombinedAttack.target.card.suit}`);
                        lastAIAction = actionKey;
                        aiActionCount.set(turnKey, actionsThisTurn + 1);
                        saveStateToHistory();
                        performAICombinedAttack(randomCombinedAttack.attackers, randomCombinedAttack.target.row, randomCombinedAttack.target.col);
                        updateUI();
                        setTimeout(() => performAITurnSequence(player), 200);
                        return;
                    }
                } else {
                    const actionKey = `attack-${randomSingleAttack.fromRow}-${randomSingleAttack.fromCol}-${randomSingleAttack.toRow}-${randomSingleAttack.toCol}`;
                    if (lastAIAction !== actionKey) {
                        console.log(`AI Player ${player} random single attack: ${randomSingleAttack.card.value}${randomSingleAttack.card.suit}`);
                        lastAIAction = actionKey;
                        aiActionCount.set(turnKey, actionsThisTurn + 1);
                        saveStateToHistory();
                        attack(randomSingleAttack.fromRow, randomSingleAttack.fromCol, randomSingleAttack.toRow, randomSingleAttack.toCol);
                        updateUI();
                        setTimeout(() => performAITurnSequence(player), 200);
                        return;
                    }
                }
            }
        }
    }
    
    // Priority 1: Summon new cards (prioritize empty positions when < 5 cards, then replacements)
    updateAIThinking('Evaluating summon options...', 2);
    const summonAction = findBestSummonAction(player);
    if (summonAction) { // Always be aggressive - no value win to worry about
        const actionKey = `summon-${summonAction.row}-${summonAction.col}-${summonAction.card.value}${summonAction.card.suit}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated summon action, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        updateAIThinking(`Summoning ${summonAction.card.value}${summonAction.card.suit}!`, 6);
        console.log(`AI Player ${player} summoning ${summonAction.card.value}${summonAction.card.suit} to (${summonAction.row},${summonAction.col})`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        const success = placeCard(summonAction.card, summonAction.row, summonAction.col);
        if (success) {
            gameState.leaderAttackedThisTurn = true;
        }
        stopAIThinking();
        updateUI();
        
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // Priority 2: Emergency defense - save cards about to be captured
    updateAIThinking('Checking defensive needs...', 3);
    const emergencyDefenseAction = findEmergencyDefenseAction(player);
    if (emergencyDefenseAction) {
        const actionKey = `defense-${emergencyDefenseAction.fromRow}-${emergencyDefenseAction.fromCol}-${emergencyDefenseAction.toRow}-${emergencyDefenseAction.toCol}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated defense action, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        console.log(`AI Player ${player} EMERGENCY: moving ${emergencyDefenseAction.card.value}${emergencyDefenseAction.card.suit} to safety from (${emergencyDefenseAction.fromRow},${emergencyDefenseAction.fromCol}) to (${emergencyDefenseAction.toRow},${emergencyDefenseAction.toCol})`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        moveCard(emergencyDefenseAction.fromRow, emergencyDefenseAction.fromCol, emergencyDefenseAction.toRow, emergencyDefenseAction.toCol);
        updateUI();
        
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // Priority 2b: Protective movement - move cards to block threats to leader
    updateAIThinking('Checking protective positioning...', 3);
    const protectiveMovementAction = findProtectiveMovement(player);
    if (protectiveMovementAction) {
        const actionKey = `protect-move-${protectiveMovementAction.fromRow}-${protectiveMovementAction.fromCol}-${protectiveMovementAction.toRow}-${protectiveMovementAction.toCol}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated protective move, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        console.log(`AI Player ${player} protective movement (${protectiveMovementAction.type}): ${protectiveMovementAction.card.value}${protectiveMovementAction.card.suit} from (${protectiveMovementAction.fromRow},${protectiveMovementAction.fromCol}) to (${protectiveMovementAction.toRow},${protectiveMovementAction.toCol}) - threat level ${protectiveMovementAction.threatLevel}`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        moveCard(protectiveMovementAction.fromRow, protectiveMovementAction.fromCol, protectiveMovementAction.toRow, protectiveMovementAction.toCol);
        updateUI();
        
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // Priority 3: Replace weak cards with better cards from hand
    updateAIThinking('Considering card replacements...', 4);
    const replaceAction = findBestCardReplacement(player);
    if (replaceAction) {
        const actionKey = `replace-${replaceAction.row}-${replaceAction.col}-${replaceAction.newCard.value}${replaceAction.newCard.suit}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated replace action, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        console.log(`AI Player ${player} replacing ${replaceAction.oldCard.value}${replaceAction.oldCard.suit} with ${replaceAction.newCard.value}${replaceAction.newCard.suit} at (${replaceAction.row},${replaceAction.col})`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        const success = replaceCard(replaceAction.row, replaceAction.col, replaceAction.newCard);
        if (success) {
            gameState.leaderAttackedThisTurn = true;
        }
        updateUI();
        
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // Priority 3: Combined attacks - Use multiple cards to capture strong enemies and reveal face-down threats
    updateAIThinking('Planning combined attacks...', 5);
    const combinedAttackAction = findBestCombinedAttack(player, isNearMoveLimit, isAggressor);
    if (combinedAttackAction) {
        const actionKey = `combined-attack-${combinedAttackAction.target.row}-${combinedAttackAction.target.col}-${combinedAttackAction.combSize}`;
        
        if (lastAIAction !== actionKey) {
            const faceDownText = combinedAttackAction.target.card.faceDown ? " [FEARLESS FACE-DOWN ASSAULT]" : "";
            if (combinedAttackAction.target.card.faceDown) {
                updateAIThinking(`Fearless assault on face-down threat!`, 6);
            } else {
                updateAIThinking(`Combined attack: ${combinedAttackAction.combSize} cards!`, 6);
            }
            console.log(`AI Player ${player} combined attack: ${combinedAttackAction.combSize} cards attacking ${combinedAttackAction.target.card.value}${combinedAttackAction.target.card.suit} at (${combinedAttackAction.target.row},${combinedAttackAction.target.col}) - Total attack: ${combinedAttackAction.totalAttack} vs ${combinedAttackAction.targetDefense}${faceDownText}`);
            lastAIAction = actionKey;
            aiActionCount.set(turnKey, actionsThisTurn + 1);
            saveStateToHistory();
            performAICombinedAttack(combinedAttackAction.attackers, combinedAttackAction.target.row, combinedAttackAction.target.col);
            stopAIThinking();
            updateUI();
            setTimeout(() => performAITurnSequence(player), 200);
            return;
        }
    }

    // Priority 4: Attack with existing cards for captures and defense
    const attackAction = findBestAttackAction(player, isNearMoveLimit, isAggressor);
    if (attackAction) {
        const actionKey = `attack-${attackAction.fromRow}-${attackAction.fromCol}-${attackAction.toRow}-${attackAction.toCol}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated action, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        const target = gameState.board[attackAction.toRow][attackAction.toCol];
        const captureText = attackAction.expectedCapture ? " [CAPTURE]" : " [DAMAGE]";
        const faceDownText = target?.faceDown ? " [REVEAL FACE-DOWN]" : "";
        const fearlessText = attackAction.isFaceDownOverride ? " [FEARLESS OVERRIDE]" : "";
        const attackerFaceDownText = attackAction.card.faceDown ? " [FACE-DOWN ATTACKER]" : "";
        
        if (target?.faceDown) {
            updateAIThinking('Fearlessly attacking face-down threat!', 6);
        } else if (attackAction.card.faceDown) {
            updateAIThinking('Using face-down card to attack!', 6);
        }
        
        console.log(`AI Player ${player} attacking with ${attackAction.card.value}${attackAction.card.suit} at (${attackAction.fromRow},${attackAction.fromCol}) -> (${attackAction.toRow},${attackAction.toCol})${captureText}${faceDownText}${fearlessText}${attackerFaceDownText}`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        attack(attackAction.fromRow, attackAction.fromCol, attackAction.toRow, attackAction.toCol);
        updateUI();
        
        // Continue sequence after delay
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // Priority 5a: Front-line formation movement (cards move in front of leader)
    const frontLineFormationAction = findFrontLineFormationMove(player);
    if (frontLineFormationAction) {
        const actionKey = `front-line-${frontLineFormationAction.type}-${frontLineFormationAction.fromRow}-${frontLineFormationAction.fromCol}-${frontLineFormationAction.toRow}-${frontLineFormationAction.toCol}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated front-line formation move, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        console.log(`AI Player ${player} front-line formation (${frontLineFormationAction.type}): ${frontLineFormationAction.card.value}${frontLineFormationAction.card.suit} from (${frontLineFormationAction.fromRow},${frontLineFormationAction.fromCol}) to (${frontLineFormationAction.toRow},${frontLineFormationAction.toCol})`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        moveCard(frontLineFormationAction.fromRow, frontLineFormationAction.fromCol, frontLineFormationAction.toRow, frontLineFormationAction.toCol);
        updateUI();
        
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // Priority 5b: Diamond flanking maneuvers (break enemy formation from behind)
    const diamondFlankingAction = findDiamondFlankingMove(player);
    if (diamondFlankingAction) {
        const actionKey = `diamond-flank-${diamondFlankingAction.fromRow}-${diamondFlankingAction.fromCol}-${diamondFlankingAction.toRow}-${diamondFlankingAction.toCol}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated diamond flanking move, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        console.log(`AI Player ${player} diamond flanking maneuver: ${diamondFlankingAction.card.value}${diamondFlankingAction.card.suit} from (${diamondFlankingAction.fromRow},${diamondFlankingAction.fromCol}) to (${diamondFlankingAction.toRow},${diamondFlankingAction.toCol}) - targeting enemy formation`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        moveCard(diamondFlankingAction.fromRow, diamondFlankingAction.fromCol, diamondFlankingAction.toRow, diamondFlankingAction.toCol);
        updateUI();
        
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // Priority 5: Move leader aggressively 
    const leaderMoveAction = findAggressiveLeaderMove(player);
    if (leaderMoveAction) {
        const actionKey = `leader-move-${leaderMoveAction.fromRow}-${leaderMoveAction.fromCol}-${leaderMoveAction.toRow}-${leaderMoveAction.toCol}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated leader move, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        console.log(`AI Player ${player} moving leader aggressively from (${leaderMoveAction.fromRow},${leaderMoveAction.fromCol}) to (${leaderMoveAction.toRow},${leaderMoveAction.toCol}) for attack`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        moveCard(leaderMoveAction.fromRow, leaderMoveAction.fromCol, leaderMoveAction.toRow, leaderMoveAction.toCol);
        updateUI();
        
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // Priority 6: Move other cards to create attack opportunities (more aggressive)
    const strategicMoveAction = findStrategicMoveAction(player);
    if (strategicMoveAction) {
        const actionKey = `move-${strategicMoveAction.fromRow}-${strategicMoveAction.fromCol}-${strategicMoveAction.toRow}-${strategicMoveAction.toCol}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated strategic move, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        console.log(`AI Player ${player} strategically moving ${strategicMoveAction.card.value}${strategicMoveAction.card.suit} from (${strategicMoveAction.fromRow},${strategicMoveAction.fromCol}) to (${strategicMoveAction.toRow},${strategicMoveAction.toCol}) for attack setup`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        moveCard(strategicMoveAction.fromRow, strategicMoveAction.fromCol, strategicMoveAction.toRow, strategicMoveAction.toCol);
        updateUI();
        
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // Priority 3: Move cards to better positions
    const moveAction = findBestMoveAction(player);
    if (moveAction) {
        const actionKey = `move-${moveAction.fromRow}-${moveAction.fromCol}-${moveAction.toRow}-${moveAction.toCol}`;
        
        // Check if this is the same action as last time (potential loop)
        if (lastAIAction === actionKey) {
            console.log(`AI Player ${player} detected repeated move action, ending turn to prevent loop`);
            aiActionCount.delete(turnKey);
            if (aiTurnTimeout) {
                clearTimeout(aiTurnTimeout);
                aiTurnTimeout = null;
            }
            setTimeout(() => endTurn(), 300);
            return;
        }
        
        console.log(`AI Player ${player} moving ${moveAction.card.value}${moveAction.card.suit} from (${moveAction.fromRow},${moveAction.fromCol}) to (${moveAction.toRow},${moveAction.toCol})`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        moveCard(moveAction.fromRow, moveAction.fromCol, moveAction.toRow, moveAction.toCol);
        updateUI();
        
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }

    // FALLBACK ACTIONS: Never end turn without doing something!
    updateAIThinking('Searching for fallback actions...', 5);
    console.log(`[AI DEBUG] No primary actions found, attempting fallback actions...`);
    
    // Fallback 1: Leader can always summon if there are cards in hand and space
    const fallbackSummonAction = findFallbackSummonAction(player);
    if (fallbackSummonAction) {
        const actionKey = `fallback-summon-${fallbackSummonAction.row}-${fallbackSummonAction.col}-${fallbackSummonAction.card.value}${fallbackSummonAction.card.suit}`;
        
        if (lastAIAction !== actionKey) {
            updateAIThinking(`Fallback: Summoning ${fallbackSummonAction.card.value}${fallbackSummonAction.card.suit}`, 6);
            console.log(`AI Player ${player} fallback summon: ${fallbackSummonAction.card.value}${fallbackSummonAction.card.suit} to (${fallbackSummonAction.row},${fallbackSummonAction.col})`);
            lastAIAction = actionKey;
            aiActionCount.set(turnKey, actionsThisTurn + 1);
            saveStateToHistory();
            const success = placeCard(fallbackSummonAction.card, fallbackSummonAction.row, fallbackSummonAction.col);
            if (success) {
                gameState.leaderAttackedThisTurn = true;
            }
            updateUI();
            setTimeout(() => performAITurnSequence(player), 200);
            return;
        }
    }
    
    // Fallback 2: Replace weak cards with better ones from hand
    const fallbackReplaceAction = findFallbackReplaceAction(player);
    if (fallbackReplaceAction) {
        const actionKey = `fallback-replace-${fallbackReplaceAction.row}-${fallbackReplaceAction.col}-${fallbackReplaceAction.newCard.value}${fallbackReplaceAction.newCard.suit}`;
        
        if (lastAIAction !== actionKey) {
            console.log(`AI Player ${player} fallback replace: ${fallbackReplaceAction.oldCard.value}${fallbackReplaceAction.oldCard.suit} with ${fallbackReplaceAction.newCard.value}${fallbackReplaceAction.newCard.suit} at (${fallbackReplaceAction.row},${fallbackReplaceAction.col})`);
            lastAIAction = actionKey;
            aiActionCount.set(turnKey, actionsThisTurn + 1);
            saveStateToHistory();
            const success = replaceCard(fallbackReplaceAction.row, fallbackReplaceAction.col, fallbackReplaceAction.newCard);
            if (success) {
                gameState.leaderAttackedThisTurn = true;
            }
            updateUI();
            setTimeout(() => performAITurnSequence(player), 200);
            return;
        }
    }
    
    // Fallback 3: Repositioning for better formation/defense
    const fallbackRepositionAction = findFallbackRepositionAction(player);
    if (fallbackRepositionAction) {
        const actionKey = `fallback-reposition-${fallbackRepositionAction.fromRow}-${fallbackRepositionAction.fromCol}-${fallbackRepositionAction.toRow}-${fallbackRepositionAction.toCol}`;
        
        if (lastAIAction !== actionKey) {
            console.log(`AI Player ${player} fallback reposition: ${fallbackRepositionAction.card.value}${fallbackRepositionAction.card.suit} from (${fallbackRepositionAction.fromRow},${fallbackRepositionAction.fromCol}) to (${fallbackRepositionAction.toRow},${fallbackRepositionAction.toCol}) for better formation`);
            lastAIAction = actionKey;
            aiActionCount.set(turnKey, actionsThisTurn + 1);
            saveStateToHistory();
            moveCard(fallbackRepositionAction.fromRow, fallbackRepositionAction.fromCol, fallbackRepositionAction.toRow, fallbackRepositionAction.toCol);
            updateUI();
            setTimeout(() => performAITurnSequence(player), 200);
            return;
        }
    }
    
    // Fallback 4: Any legal move at all (absolute last resort)
    const desperateAction = findAnyLegalAction(player);
    if (desperateAction) {
        console.log(`AI Player ${player} desperate action: ${desperateAction.type}`);
        const actionKey = `desperate-${desperateAction.type}-${Math.random()}`;
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        
        if (desperateAction.type === 'move') {
            moveCard(desperateAction.fromRow, desperateAction.fromCol, desperateAction.toRow, desperateAction.toCol);
        } else if (desperateAction.type === 'attack') {
            attack(desperateAction.fromRow, desperateAction.fromCol, desperateAction.toRow, desperateAction.toCol);
        }
        
        stopAIThinking();
        updateUI();
        setTimeout(() => performAITurnSequence(player), 200);
        return;
    }
    
    // BEHAVIORAL REQUIREMENT: Try to move unmoved cards before ending turn
    const forceMovementAction = findForceMovementAction(player);
    if (forceMovementAction) {
        const actionKey = `force-move-${forceMovementAction.fromRow}-${forceMovementAction.fromCol}-${forceMovementAction.toRow}-${forceMovementAction.toCol}`;
        
        // ALWAYS execute force movement - don't check for repeated actions since this is fallback behavior
        console.log(`AI Player ${player} FORCE MOVEMENT: ${forceMovementAction.card.value}${forceMovementAction.card.suit} from (${forceMovementAction.fromRow},${forceMovementAction.fromCol}) to (${forceMovementAction.toRow},${forceMovementAction.toCol}) - ensuring cards move around`);
        lastAIAction = actionKey;
        aiActionCount.set(turnKey, actionsThisTurn + 1);
        saveStateToHistory();
        moveCard(forceMovementAction.fromRow, forceMovementAction.fromCol, forceMovementAction.toRow, forceMovementAction.toCol);
        updateUI();
        setTimeout(() => performAITurnSequence(player), 100);
        return;
    }
    
    // Only end turn if absolutely no actions are possible
    updateAIThinking('No actions available, ending turn', 6);
    console.log(`AI Player ${player} ending turn after ${actionsThisTurn} actions - truly no more moves available`);
    
    // DEBUG: Log final state before ending turn
    console.log(`[AI DEBUG] Final turn summary for player ${player}:`);
    console.log(`[AI DEBUG] - Actions this turn: ${actionsThisTurn}`);
    console.log(`[AI DEBUG] - Cards moved this turn: ${gameState.cardsMovedThisTurn.size}`);
    console.log(`[AI DEBUG] - Moved card IDs:`, Array.from(gameState.cardsMovedThisTurn));
    
    // Count total cards on board for this player
    let totalCards = 0;
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player) {
                totalCards++;
            }
        }
    }
    console.log(`[AI DEBUG] - Total cards on board: ${totalCards}`);
    
    aiActionCount.delete(turnKey);
    lastAIAction = null; // Reset action tracking
    
    // Clear emergency timeout
    if (aiTurnTimeout) {
        clearTimeout(aiTurnTimeout);
        aiTurnTimeout = null;
    }
    
    stopAIThinking();
    setTimeout(() => endTurn(), 300);
}

// BEHAVIORAL REQUIREMENT: Force movement of unmoved cards to ensure dynamic gameplay
function findForceMovementAction(player) {
    console.log(`[AI DEBUG] Finding force movement action for player ${player}`);
    
    // Find all cards that haven't moved this turn
    const unmovedCards = [];
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && !gameState.cardsMovedThisTurn.has(card.id)) {
                unmovedCards.push({ card, row: r, col: c });
            }
        }
    }
    
    console.log(`[AI DEBUG] Found ${unmovedCards.length} unmoved cards for force movement`);
    console.log(`[AI DEBUG] Cards moved this turn:`, Array.from(gameState.cardsMovedThisTurn));
    
    if (unmovedCards.length === 0) {
        console.log(`[AI DEBUG] No unmoved cards found - all cards have been moved this turn`);
        return null;
    }
    
    // Try to find ANY movement for unmoved cards - ultra low threshold but with basic strategy
    for (const { card, row, col } of unmovedCards) {
        console.log(`[AI DEBUG] Checking movement for ${card.value}${card.suit} at [${row},${col}]`);
        const validMoves = getValidMoves(card, row, col);
        console.log(`[AI DEBUG] Valid moves found: ${validMoves.length}`);
        if (validMoves.length === 0) {
            console.log(`[AI DEBUG] No valid moves for ${card.value}${card.suit} at [${row},${col}]`);
            continue;
        }
        
        let bestMove = null;
        let bestScore = -999;
        
        for (const [newRow, newCol] of validMoves) {
            let score = 1; // Base score for any movement
            
            // Basic strategic bonuses
            if (card.suit === 'diamonds') {
                // Diamonds: move away from own leader
                const leaderPos = findLeaderPosition(player);
                if (leaderPos) {
                    const currentDist = Math.abs(row - leaderPos[0]) + Math.abs(col - leaderPos[1]);
                    const newDist = Math.abs(newRow - leaderPos[0]) + Math.abs(newCol - leaderPos[1]);
                    if (newDist > currentDist) score += 2;
                }
            } else {
                // Non-diamonds: move toward own leader for protection
                const leaderPos = findLeaderPosition(player);
                if (leaderPos) {
                    const currentDist = Math.abs(row - leaderPos[0]) + Math.abs(col - leaderPos[1]);
                    const newDist = Math.abs(newRow - leaderPos[0]) + Math.abs(newCol - leaderPos[1]);
                    if (newDist < currentDist) score += 2;
                }
            }
            
            // Small bonus for advancing toward enemy territory
            const enemyPlayer = player === 1 ? 2 : 1;
            if ((enemyPlayer === 1 && newRow < row) || (enemyPlayer === 2 && newRow > row)) {
                score += 1;
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestMove = [newRow, newCol];
            }
        }
        
        if (bestMove) {
            console.log(`[AI DEBUG] Force movement for ${card.value}${card.suit}: [${row},${col}] to [${bestMove[0]},${bestMove[1]}] (score: ${bestScore})`);
            return {
                card: card,
                fromRow: row,
                fromCol: col,
                toRow: bestMove[0],
                toCol: bestMove[1]
            };
        }
    }
    
    // EMERGENCY FALLBACK: If no unmoved cards can move, try to move ANY card
    console.log(`[AI DEBUG] No unmoved cards could move - trying emergency fallback with ANY card`);
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player) {
                console.log(`[AI DEBUG] Emergency check: ${card.value}${card.suit} at [${r},${c}]`);
                const validMoves = getValidMoves(card, r, c);
                if (validMoves.length > 0) {
                    const randomMove = validMoves[Math.floor(Math.random() * validMoves.length)];
                    console.log(`[AI DEBUG] EMERGENCY MOVEMENT: ${card.value}${card.suit} from [${r},${c}] to [${randomMove[0]},${randomMove[1]}]`);
                    return {
                        card: card,
                        fromRow: r,
                        fromCol: c,
                        toRow: randomMove[0],
                        toCol: randomMove[1]
                    };
                }
            }
        }
    }
    
    console.log(`[AI DEBUG] Absolutely no cards can move - this should be very rare`);
    return null;
}

function findBestAttackAction(player, isNearMoveLimit = false, isAggressor = false) {
    // Get all player's cards on the board that can attack
    const playerCards = [];
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && !isCardExhausted(card) && card.attack > 0) {
                playerCards.push({ card, row: r, col: c });
            }
        }
    }

    // CAPTURE-FOCUSED STRATEGY: Find the best attack that maximizes card capture
    let bestAttack = null;
    let bestScore = -1;

    for (const { card, row, col } of playerCards) {
        const validAttacks = getValidAttacks(card, row, col);
        for (const [targetRow, targetCol] of validAttacks) {
            const target = gameState.board[targetRow][targetCol];
            if (target && target.owner !== player) {
                let score = 0;

                // PRIMARY: Capture probability and value
                const canCapture = card.attack >= target.defense;
                if (canCapture) {
                // MASSIVE bonus for guaranteed captures
                let captureBonus = 100;
                
                // If approaching move limit and we're the aggressor, be extra aggressive about captures
                if (isNearMoveLimit && isAggressor) {
                    captureBonus += 200; // Aggressor needs to win by captures
                }
                
                // STRATEGIC: Extra bonus for attacking face-down cards (reveal and disable them)
                if (target.faceDown) {
                    captureBonus += 150; // Strong bonus for revealing face-down cards
                    console.log(`[AI DEBUG] Face-down card attack bonus: +150 for revealing unknown threat`);
                }
                
                score += captureBonus;                    // Bonus based on captured card value
                    const captureValue = target.attack + target.defense;
                    score += captureValue * 10;
                    
                    // HUGE bonus for capturing enemy leader
                    if (target.suit === 'joker') {
                        score += 500; // Leader capture is game-changing
                    }
                    
                    // Bonus for capturing high-attack cards (neutralizing threats)
                    if (target.attack >= 4) {
                        score += target.attack * 15; // Remove dangerous attackers
                    }
                } else {
                    // Even if we can't capture, weakening enemy cards has value
                    const damageDealt = Math.min(card.attack, target.defense);
                    score += damageDealt * 5; // Smaller bonus for damage
                    
                    // STRATEGIC: Extra bonus for attacking face-down cards even if we can't capture them
                    // This reveals them and potentially weakens unknown threats
                    if (target.faceDown) {
                        score += 75; // Good bonus for revealing face-down cards even without capture
                        console.log(`[AI DEBUG] Face-down reveal bonus: +75 for attacking to reveal unknown card`);
                    }
                }

                // DEFENSE: Prioritize saving our own cards under threat
                // Check if our attacking card is in danger and this attack helps
                const myCardThreats = findThreatsToCard(card, row, col, player);
                if (myCardThreats.length > 0) {
                    // If our card is threatened, prioritize attacks that might save it
                    if (myCardThreats.some(threat => threat.row === targetRow && threat.col === targetCol)) {
                        score += 80; // High bonus for eliminating immediate threats
                    }
                }

                // OFFENSIVE: Chain capture opportunities
                // Check if this attack opens up more capture opportunities
                const enemyCards = getAllEnemyCards(player);
                for (const enemyCard of enemyCards) {
                    if (enemyCard.row === targetRow && enemyCard.col === targetCol) continue; // Skip the target we're attacking
                    
                    const distance = Math.abs(targetRow - enemyCard.row) + Math.abs(targetCol - enemyCard.col);
                    if (distance <= 2) { // If we'll be close to other enemies after this attack
                        const couldCaptureNext = card.attack >= enemyCard.card.defense;
                        if (couldCaptureNext) {
                            score += 30; // Bonus for potential follow-up captures
                        }
                    }
                }

                // TACTICAL: Prefer attacks with lower risk
                // Check if attacking card will be safe after the attack
                const wouldBeSafeAfterAttack = !willCardBeThreatenedAtPosition(card, targetRow, targetCol, player);
                if (wouldBeSafeAfterAttack) {
                    score += 20; // Bonus for safe attacks
                } else if (target.faceDown) {
                    // FEARLESS: Don't penalize risky attacks on face-down cards - the intelligence value is worth it
                    score += 10; // Small bonus even for risky face-down attacks (revelation is strategic)
                    console.log(`[AI DEBUG] Fearless face-down attack: accepting risk to reveal unknown threat`);
                }

                // Add strategic randomization to make AI less predictable
                if (shouldRandomizeStrategy()) {
                    score = addRandomNoise(score, 75); // Add up to ±75 points of noise
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestAttack = {
                        card,
                        fromRow: row,
                        fromCol: col,
                        toRow: targetRow,
                        toCol: targetCol,
                        expectedCapture: canCapture,
                        targetValue: target.attack + target.defense
                    };
                }
            }
        }
    }

    // FEARLESS OVERRIDE: If we found a face-down attack but it scored lower than a face-up attack,
    // consider if the face-down attack is still worth doing for intelligence gathering
    if (bestAttack && !bestAttack.target?.faceDown) {
        // Look for any face-down attack opportunity that might have been scored lower
        for (let r = 0; r < 11; r++) {
            for (let c = 0; c < 11; c++) {
                const card = gameState.board[r][c];
                if (card && card.owner === player && !isCardExhausted(card) && card.attack > 0) {
                    const validAttacks = getValidAttacks(card, r, c);
                    for (const [targetRow, targetCol] of validAttacks) {
                        const target = gameState.board[targetRow][targetCol];
                        if (target && target.owner !== player && target.faceDown) {
                            // Found a face-down target - if it has decent capture potential, consider it
                            if (card.attack >= target.defense && bestScore < 300) {
                                console.log(`[AI DEBUG] FEARLESS OVERRIDE: Prioritizing face-down capture over lower-scoring face-up attack`);
                                return {
                                    card,
                                    fromRow: r,
                                    fromCol: c,
                                    toRow: targetRow,
                                    toCol: targetCol,
                                    expectedCapture: true,
                                    targetValue: target.attack + target.defense,
                                    isFaceDownOverride: true
                                };
                            }
                        }
                    }
                }
            }
        }
    }

    return bestAttack;
}

function findBestCombinedAttack(player, isNearMoveLimit = false, isAggressor = false) {
    // Get all player's cards that can attack
    const playerCards = [];
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && !isCardExhausted(card) && card.attack > 0) {
                playerCards.push({ card, row: r, col: c });
            }
        }
    }

    if (playerCards.length < 2) return null; // Need at least 2 cards for combined attack

    // Find all possible enemy targets
    const enemyPlayer = player === 1 ? 2 : 1;
    const enemyTargets = [];
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const target = gameState.board[r][c];
            if (target && target.owner === enemyPlayer) {
                enemyTargets.push({ card: target, row: r, col: c });
            }
        }
    }

    let bestCombinedAttack = null;
    let bestScore = -1;

    // Try different combinations of attacking cards
    for (let combSize = 2; combSize <= Math.min(playerCards.length, 4); combSize++) {
        const combinations = getCombinations(playerCards, combSize);
        
        for (const attackers of combinations) {
            for (const target of enemyTargets) {
                // Check if all attackers can reach the target
                const canAllAttack = attackers.every(attacker => {
                    const validAttacks = getValidAttacks(attacker.card, attacker.row, attacker.col);
                    return validAttacks.some(([r, c]) => r === target.row && c === target.col);
                });

                if (!canAllAttack) continue;

                // Calculate combined attack power
                let totalAttack = 0;
                for (const attacker of attackers) {
                    totalAttack += attacker.card.attack;
                }

                // Check if combined attack can capture the target
                const canCapture = totalAttack >= target.card.defense;
                
                if (canCapture) {
                    let score = 0;
                    
                    // MASSIVE bonus for captures that single cards couldn't achieve
                    const singleCardCantCapture = attackers.every(attacker => attacker.card.attack < target.card.defense);
                    if (singleCardCantCapture) {
                        score += 300; // Huge bonus for enabling impossible captures
                    }
                    
                    // STRATEGIC: HUGE bonus for combined attacks on face-down cards
                    if (target.card.faceDown) {
                        score += 400; // Massive bonus for using multiple cards to reveal and disable face-down threats
                        console.log(`[AI DEBUG] Face-down combined attack bonus: +400 for revealing unknown threat with ${combSize} cards`);
                        
                        // Additional bonus if this requires multiple cards when single cards couldn't do it
                        if (singleCardCantCapture) {
                            score += 200; // Extra bonus for coordinated assault on hidden threats
                            console.log(`[AI DEBUG] Face-down coordinated assault bonus: +200 for multi-card reveal`);
                        }
                    }
                    
                    // Bonus based on target value
                    const targetValue = target.card.attack + target.card.defense;
                    score += targetValue * 15;
                    
                    // MASSIVE bonus for capturing enemy leader with combined attack
                    if (target.card.suit === 'joker') {
                        score += 800; // Even higher than single attack since it requires coordination
                    }
                    
                    // Bonus for high-value targets that are normally too strong
                    if (target.card.defense >= 5) {
                        score += target.card.defense * 20; // Reward taking down fortress cards
                    }
                    
                    // If approaching move limit and we're the aggressor, prioritize captures
                    if (isNearMoveLimit && isAggressor) {
                        score += 400; // Extra urgency for combined attacks
                    }
                    
                    // Penalty based on number of cards used (efficiency matters)
                    score -= (combSize - 2) * 10; // Prefer smaller combinations when possible
                    
                    // Check safety of attacking cards after the attack
                    let safetySummary = 0;
                    for (const attacker of attackers) {
                        const wouldBeSafe = !willCardBeThreatenedAtPosition(attacker.card, target.row, target.col, player);
                        if (wouldBeSafe) {
                            safetySummary += 10;
                        } else {
                            // FEARLESS: Reduce safety penalty for face-down targets - intel gathering is worth the risk
                            const safetyPenalty = target.card.faceDown ? -5 : -20; // Much smaller penalty for face-down attacks
                            safetySummary += safetyPenalty;
                            if (target.card.faceDown) {
                                console.log(`[AI DEBUG] Fearless combined attack: reduced safety penalty for face-down target`);
                            }
                        }
                    }
                    score += safetySummary;

                    // Add strategic randomization for combined attacks
                    if (shouldRandomizeStrategy()) {
                        score = addRandomNoise(score, 100); // Higher noise for complex decisions
                    }

                    if (score > bestScore) {
                        bestScore = score;
                        bestCombinedAttack = {
                            attackers: attackers,
                            target: target,
                            totalAttack: totalAttack,
                            targetDefense: target.card.defense,
                            expectedCapture: true,
                            targetValue: targetValue,
                            combSize: combSize
                        };
                    }
                }
            }
        }
    }

    return bestCombinedAttack;
}

// Helper function to generate combinations
function getCombinations(array, size) {
    if (size === 1) return array.map(item => [item]);
    if (size > array.length) return [];
    
    const combinations = [];
    for (let i = 0; i <= array.length - size; i++) {
        const head = array[i];
        const tailCombinations = getCombinations(array.slice(i + 1), size - 1);
        for (const tail of tailCombinations) {
            combinations.push([head, ...tail]);
        }
    }
    return combinations;
}

function performAICombinedAttack(attackers, targetRow, targetCol) {
    console.log(`[AI DEBUG] Executing combined attack with ${attackers.length} cards on target at [${targetRow},${targetCol}]`);
    
    // IMPORTANT: Clear any existing selections first to prevent conflicts
    gameState.selectedCards = [];
    gameState.selectedCard = null;
    gameState.validMoves = [];
    gameState.validAttacks = [];
    gameState.selectedHex = null;
    
    // Set up the multi-selection state for the AI attack
    for (const attacker of attackers) {
        console.log(`[AI DEBUG] Adding attacker: ${attacker.card.value}${attacker.card.suit} at [${attacker.row},${attacker.col}]`);
        gameState.selectedCards.push({
            card: attacker.card,
            position: [attacker.row, attacker.col]
        });
    }
    
    console.log(`[AI DEBUG] Multi-selection state set up with ${gameState.selectedCards.length} cards`);
    
    // Execute the combined attack using the existing game logic
    const target = gameState.board[targetRow][targetCol];
    if (target) {
        console.log(`[AI DEBUG] Combined attack target: ${target.value}${target.suit} (Defense: ${target.defense})`);
        try {
            performCombinedAttack(targetRow, targetCol);
            console.log(`[AI DEBUG] Combined attack executed successfully`);
        } catch (error) {
            console.error(`[AI DEBUG] Error during combined attack execution:`, error);
        }
    } else {
        console.log(`[AI DEBUG] Combined attack failed - target no longer exists at [${targetRow},${targetCol}]`);
    }
    
    // CRITICAL: Always clear all selections to prevent stuck state
    console.log(`[AI DEBUG] Clearing selections after combined attack...`);
    gameState.selectedCards = [];
    gameState.selectedCard = null;
    gameState.validMoves = [];
    gameState.validAttacks = [];
    gameState.selectedHex = null;
    gameState.blockedMoves = [];
    gameState.absorptions = [];
    
    console.log(`[AI DEBUG] Combined attack cleanup completed - all selections cleared`);
}

function findBestLeaderProtectionAction(player) {
    const leaderPos = findLeaderPosition(player);
    if (!leaderPos) return null;
    
    const [leaderRow, leaderCol] = leaderPos;
    const leader = gameState.board[leaderRow][leaderCol];
    
    // ULTRA-AGGRESSIVE THREAT DETECTION: Leader protection is CRITICAL (+3 cards if lost!)
    const leaderThreats = findThreatsToCard(leader, leaderRow, leaderCol, player);
    const immediateThreats = leaderThreats.filter(threat => threat.canCapture);
    
    // ENHANCED: Also detect potential future threats (2-turn threats)
    const potentialThreats = [];
    const nearbyThreats = [];
    const opponent = player === 1 ? 2 : 1;
    
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const enemyCard = gameState.board[r][c];
            if (enemyCard && enemyCard.owner === opponent && !isCardExhausted(enemyCard)) {
                const distanceToLeader = Math.abs(r - leaderRow) + Math.abs(c - leaderCol);
                
                // Check if enemy is getting dangerously close (within 3 hexes)
                if (distanceToLeader <= 3 && enemyCard.attack > 0) {
                    nearbyThreats.push({
                        card: enemyCard,
                        row: r,
                        col: c,
                        distance: distanceToLeader,
                        canCapture: enemyCard.attack >= leader.defense
                    });
                }
                
                // Check if enemy could threaten leader after 1-2 moves
                if (distanceToLeader <= 4 && enemyCard.attack > 0) {
                    const enemyMoves = getValidMoves(enemyCard, r, c);
                    for (const [newR, newC] of enemyMoves) {
                        const newDistance = Math.abs(newR - leaderRow) + Math.abs(newC - leaderCol);
                        if (newDistance <= 2) {
                            // Check if from this position, enemy could attack leader
                            const wouldThreatenLeader = getValidAttacks(enemyCard, newR, newC)
                                .some(([ar, ac]) => ar === leaderRow && ac === leaderCol);
                            
                            if (wouldThreatenLeader) {
                                potentialThreats.push({
                                    card: enemyCard,
                                    currentRow: r,
                                    currentCol: c,
                                    threatRow: newR,
                                    threatCol: newC,
                                    canCaptureAfterMove: enemyCard.attack >= leader.defense
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    
    const dangerousNearbyThreats = nearbyThreats.filter(threat => threat.canCapture || threat.distance <= 2);
    const dangerousPotentialThreats = potentialThreats.filter(threat => threat.canCaptureAfterMove);
    
    console.log(`[AI DEBUG] ULTRA-PROTECTIVE Leader Analysis:
        - Immediate threats: ${immediateThreats.length}
        - Nearby dangerous enemies: ${dangerousNearbyThreats.length}
        - Future threats (1-2 moves): ${dangerousPotentialThreats.length}
        - Total danger level: ${immediateThreats.length + dangerousNearbyThreats.length + dangerousPotentialThreats.length}`);
    
    // ACT ON ANY LEVEL OF THREAT - Leader protection is paramount!
    const totalThreatLevel = immediateThreats.length + dangerousNearbyThreats.length + dangerousPotentialThreats.length;
    if (totalThreatLevel === 0) return null; // Only skip if absolutely no threats detected
    
    let bestProtectionAction = null;
    let bestScore = -1;
    
    // Strategy 1: Move leader to safety
    const leaderMoves = getValidMoves(leader, leaderRow, leaderCol);
    for (const [newRow, newCol] of leaderMoves) {
        const wouldBeSafe = !willCardBeThreatenedAtPosition(leader, newRow, newCol, player);
        if (wouldBeSafe) {
            let score = 500; // MASSIVE base score - leader safety is paramount!
            
            // HUGE bonus for escaping immediate death
            if (immediateThreats.length > 0) {
                score += 1000; // Emergency evacuation bonus
            }
            
            // Major bonus for avoiding future threats
            if (dangerousPotentialThreats.length > 0) {
                score += 300; // Proactive safety bonus
            }
            
            // Bonus for getting away from nearby dangerous enemies
            let distanceFromEnemiesScore = 0;
            for (const threat of dangerousNearbyThreats) {
                const newDistanceFromThreat = Math.abs(newRow - threat.row) + Math.abs(newCol - threat.col);
                if (newDistanceFromThreat > threat.distance) {
                    distanceFromEnemiesScore += (newDistanceFromThreat - threat.distance) * 50; // Big bonus for increasing distance
                }
            }
            score += distanceFromEnemiesScore;
            
            // REQUIREMENT: Strong preference for positions BEHIND friendly cards
            let protectionScore = 0;
            for (let r = 0; r < 11; r++) {
                for (let c = 0; c < 11; c++) {
                    const friendlyCard = gameState.board[r][c];
                    if (friendlyCard && friendlyCard.owner === player && friendlyCard !== leader) {
                        const distance = Math.abs(newRow - r) + Math.abs(newCol - c);
                        
                        // Check if this friendly card is between us and enemies (acting as shield)
                        let isShieldingFromEnemies = false;
                        for (const threat of [...immediateThreats, ...dangerousPotentialThreats, ...dangerousNearbyThreats]) {
                            const threatRow = threat.row || threat.currentRow;
                            const threatCol = threat.col || threat.currentCol;
                            
                            // Check if friendly card is on the line between new leader position and threat
                            const friendlyToThreat = Math.abs(r - threatRow) + Math.abs(c - threatCol);
                            const friendlyToLeader = distance;
                            const leaderToThreat = Math.abs(newRow - threatRow) + Math.abs(newCol - threatCol);
                            
                            if (friendlyToThreat + friendlyToLeader <= leaderToThreat + 1) {
                                isShieldingFromEnemies = true;
                                break;
                            }
                        }
                        
                        if (isShieldingFromEnemies) {
                            protectionScore += 200; // HUGE bonus for being behind protective cards
                        } else if (distance === 1) {
                            protectionScore += 80; // Adjacent protector
                        } else if (distance === 2) {
                            protectionScore += 40; // Nearby support
                        }
                        
                        // Extra bonus if protector is strong
                        if (distance <= 2 && friendlyCard.attack >= 5) {
                            protectionScore += 60; // Strong guardian bonus
                        }
                        
                        // REQUIREMENT: Huge bonus for positions that are "behind" friendly cards relative to starting area
                        const isBehindFriendly = (player === 1 && newRow < r) || (player === 2 && newRow > r);
                        if (isBehindFriendly && distance <= 2) {
                            protectionScore += 150; // Major bonus for retreat behind friendlies
                        }
                    }
                }
            }
            score += protectionScore;
            
            // Prefer back-row positions for maximum safety
            const distanceFromBackRow = player === 1 ? newRow : (10 - newRow);
            score += (10 - distanceFromBackRow) * 30; // Heavy back-row preference
            
            // Still consider board control, but lower priority than safety
            const distanceFromCenter = Math.abs(newRow - 5) + Math.abs(newCol - 5);
            score += (10 - distanceFromCenter) * 5; // Reduced center bonus
            
            // Add minimal randomization to leader movement (safety first!)
            if (shouldRandomizeStrategy()) {
                score = addRandomNoise(score, 15); // Very small noise for leader safety
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestProtectionAction = {
                    type: 'move_leader',
                    fromRow: leaderRow,
                    fromCol: leaderCol,
                    toRow: newRow,
                    toCol: newCol,
                    priority: 'leader_safety'
                };
            }
        }
    }
    
    // Strategy 2: Attack the threats directly
    for (const threat of immediateThreats) {
        // Find cards that can attack this threat
        const playerCards = [];
        for (let r = 0; r < 11; r++) {
            for (let c = 0; c < 11; c++) {
                const card = gameState.board[r][c];
                if (card && card.owner === player && !isCardExhausted(card) && card.attack > 0) {
                    const validAttacks = getValidAttacks(card, r, c);
                    if (validAttacks.some(([ar, ac]) => ar === threat.row && ac === threat.col)) {
                        playerCards.push({ card, row: r, col: c });
                    }
                }
            }
        }
        
        // Single card attacks on threats
        for (const attacker of playerCards) {
            const canCapture = attacker.card.attack >= threat.card.defense;
            if (canCapture) {
                let score = 800; // ULTRA-HIGH priority for eliminating threats to leader!
                score += threat.card.attack * 50; // MASSIVE bonus for eliminating dangerous threats
                
                // Extra bonus if this threat can actually capture leader
                if (threat.canCapture) {
                    score += 1200; // Emergency threat elimination
                }
                
                // Bonus for eliminating high-value threats
                if (threat.card.attack >= 7) {
                    score += 400; // Very dangerous enemy bonus
                } else if (threat.card.attack >= 5) {
                    score += 200; // Dangerous enemy bonus
                }
                
                if (score > bestScore) {
                    bestScore = score;
                    bestProtectionAction = {
                        type: 'attack_threat',
                        fromRow: attacker.row,
                        fromCol: attacker.col,
                        toRow: threat.row,
                        toCol: threat.col,
                        priority: 'eliminate_threat'
                    };
                }
            }
        }
        
        // Combined attacks on threats (if single cards can't handle it)
        const singleCardCantCapture = playerCards.every(attacker => attacker.card.attack < threat.card.defense);
        if (singleCardCantCapture && playerCards.length >= 2) {
            // Try 2-card combinations
            for (let i = 0; i < playerCards.length - 1; i++) {
                for (let j = i + 1; j < playerCards.length; j++) {
                    const attacker1 = playerCards[i];
                    const attacker2 = playerCards[j];
                    const combinedAttack = attacker1.card.attack + attacker2.card.attack;
                    
                    if (combinedAttack >= threat.card.defense) {
                        let score = 900; // ULTRA-HIGH priority for coordinated leader defense
                        score += threat.card.attack * 75; // MASSIVE bonus for threat elimination
                        
                        // Huge bonus if this threat can capture leader
                        if (threat.canCapture) {
                            score += 1500; // Emergency coordinated defense
                        }
                        
                        // Bonus for eliminating very dangerous enemies
                        if (threat.card.attack >= 8) {
                            score += 600;
                        } else if (threat.card.attack >= 6) {
                            score += 300;
                        }
                        
                        if (score > bestScore) {
                            bestScore = score;
                            bestProtectionAction = {
                                type: 'combined_attack_threat',
                                attackers: [attacker1, attacker2],
                                target: threat,
                                priority: 'coordinate_defense'
                            };
                        }
                    }
                }
            }
        }
    }
    
    // Strategy 3: Block with other cards (interposition)
    const leaderNeighbors = getHexNeighbors(leaderRow, leaderCol);
    for (const [blockRow, blockCol] of leaderNeighbors) {
        if (gameState.board[blockRow][blockCol]) continue; // Position occupied
        
        // Find cards that can move to block
        for (let r = 0; r < 11; r++) {
            for (let c = 0; c < 11; c++) {
                const card = gameState.board[r][c];
                if (card && card.owner === player && card !== leader) {
                    const validMoves = getValidMoves(card, r, c);
                    if (validMoves.some(([mr, mc]) => mr === blockRow && mc === blockCol)) {
                        // Check if this position would block some threats
                        let blocksThreats = 0;
                        for (const threat of immediateThreats) {
                            const threatAttacks = getValidAttacks(threat.card, threat.row, threat.col);
                            const wouldBlockThreat = !threatAttacks.some(([ar, ac]) => ar === leaderRow && ac === leaderCol);
                            if (wouldBlockThreat) blocksThreats++;
                        }
                        
                        if (blocksThreats > 0) {
                            let score = 80 + (blocksThreats * 20);
                            
                            if (score > bestScore) {
                                bestScore = score;
                                bestProtectionAction = {
                                    type: 'block_for_leader',
                                    fromRow: r,
                                    fromCol: c,
                                    toRow: blockRow,
                                    toCol: blockCol,
                                    priority: 'interposition'
                                };
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Strategy 4: PROACTIVE ELIMINATION of nearby dangerous enemies
    for (const nearbyThreat of dangerousNearbyThreats) {
        const playerCards = [];
        for (let r = 0; r < 11; r++) {
            for (let c = 0; c < 11; c++) {
                const card = gameState.board[r][c];
                if (card && card.owner === player && !isCardExhausted(card) && card.attack > 0) {
                    const validAttacks = getValidAttacks(card, r, c);
                    if (validAttacks.some(([ar, ac]) => ar === nearbyThreat.row && ac === nearbyThreat.col)) {
                        playerCards.push({ card, row: r, col: c });
                    }
                }
            }
        }
        
        for (const attacker of playerCards) {
            const canEliminate = attacker.card.attack >= nearbyThreat.card.defense;
            if (canEliminate) {
                let score = 400; // High priority for eliminating nearby threats
                score += nearbyThreat.card.attack * 30;
                score += (4 - nearbyThreat.distance) * 100; // Closer = higher priority
                
                if (nearbyThreat.canCapture) {
                    score += 800; // Huge bonus if nearby threat can capture leader
                }
                
                if (score > bestScore) {
                    bestScore = score;
                    bestProtectionAction = {
                        type: 'eliminate_nearby_threat',
                        fromRow: attacker.row,
                        fromCol: attacker.col,
                        toRow: nearbyThreat.row,
                        toCol: nearbyThreat.col,
                        priority: 'proactive_defense'
                    };
                }
            }
        }
    }
    
    // Strategy 5: PREVENTIVE STRIKES against potential future threats
    for (const potentialThreat of dangerousPotentialThreats) {
        const playerCards = [];
        for (let r = 0; r < 11; r++) {
            for (let c = 0; c < 11; c++) {
                const card = gameState.board[r][c];
                if (card && card.owner === player && !isCardExhausted(card) && card.attack > 0) {
                    const validAttacks = getValidAttacks(card, r, c);
                    if (validAttacks.some(([ar, ac]) => ar === potentialThreat.currentRow && ac === potentialThreat.currentCol)) {
                        playerCards.push({ card, row: r, col: c });
                    }
                }
            }
        }
        
        for (const attacker of playerCards) {
            const canEliminate = attacker.card.attack >= potentialThreat.card.defense;
            if (canEliminate) {
                let score = 300; // Good priority for preventing future threats
                score += potentialThreat.card.attack * 25;
                
                if (potentialThreat.canCaptureAfterMove) {
                    score += 600; // Major bonus for preventing future leader capture
                }
                
                if (score > bestScore) {
                    bestScore = score;
                    bestProtectionAction = {
                        type: 'prevent_future_threat',
                        fromRow: attacker.row,
                        fromCol: attacker.col,
                        toRow: potentialThreat.currentRow,
                        toCol: potentialThreat.currentCol,
                        priority: 'preventive_strike'
                    };
                }
            }
        }
    }
    
    return bestProtectionAction;
}

// Helper functions for capture-focused strategy
function findThreatsToCard(card, row, col, player) {
    const threats = [];
    const enemyPlayer = player === 1 ? 2 : 1;
    
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const enemyCard = gameState.board[r][c];
            if (enemyCard && enemyCard.owner === enemyPlayer && !isCardExhausted(enemyCard)) {
                const enemyAttacks = getValidAttacks(enemyCard, r, c);
                for (const [attackRow, attackCol] of enemyAttacks) {
                    if (attackRow === row && attackCol === col) {
                        // This enemy can attack our card
                        if (enemyCard.attack >= card.defense) {
                            threats.push({ card: enemyCard, row: r, col: c, canCapture: true });
                        } else {
                            threats.push({ card: enemyCard, row: r, col: c, canCapture: false });
                        }
                    }
                }
            }
        }
    }
    
    return threats;
}

function getAllEnemyCards(player) {
    const enemyCards = [];
    const enemyPlayer = player === 1 ? 2 : 1;
    
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === enemyPlayer) {
                enemyCards.push({ card, row: r, col: c });
            }
        }
    }
    
    return enemyCards;
}

function willCardBeThreatenedAtPosition(card, row, col, player) {
    const enemyPlayer = player === 1 ? 2 : 1;
    
    // Check if any enemy card can capture this card at the new position
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const enemyCard = gameState.board[r][c];
            if (enemyCard && enemyCard.owner === enemyPlayer && !isCardExhausted(enemyCard)) {
                const enemyAttacks = getValidAttacks(enemyCard, r, c);
                for (const [attackRow, attackCol] of enemyAttacks) {
                    if (attackRow === row && attackCol === col && enemyCard.attack >= card.defense) {
                        return true; // This position is threatened
                    }
                }
            }
        }
    }
    
    return false;
}

function findBestSummonAction(player) {
    const leaderPos = findLeaderPosition(player);
    console.log(`[AI DEBUG] findBestSummonAction - Player ${player}, Leader at:`, leaderPos, `LeaderAttacked: ${gameState.leaderAttackedThisTurn}, Hand length: ${gameState.players[player].hand.length}`);
    
    // Basic requirements check
    if (!leaderPos || gameState.players[player].hand.length === 0) {
        console.log(`[AI DEBUG] Cannot summon - no leader:${!leaderPos}, no hand:${gameState.players[player].hand.length === 0}`);
        return null;
    }
    
    // Allow summoning even if leader attacked this turn (requirement: always summon if possible)
    if (gameState.leaderAttackedThisTurn) {
        console.log(`[AI DEBUG] Leader attacked this turn but STILL ATTEMPTING SUMMON (forced aggressive summoning)`);
    }

    // Count current cards on the map
    let totalCardsOnMap = 0;
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && card.suit !== 'joker') {
                totalCardsOnMap++;
            }
        }
    }
    
    console.log(`[AI DEBUG] Player ${player} has ${totalCardsOnMap} cards on map`);

    // NEW SMART SUMMONING STRATEGY:
    
    // CASE 1: Less than 5 cards - summon the best one out
    if (totalCardsOnMap < 5) {
        console.log(`[AI DEBUG] CASE 1: Less than 5 cards (${totalCardsOnMap}) - summon best card available`);
        return findBestCardToSummon(player, true); // Allow summoning to any adjacent empty space
    }
    
    // CASE 2: Already have 5 cards - check for replacement opportunities
    console.log(`[AI DEBUG] CASE 2: Have 5 cards - checking replacement opportunities`);
    const replacementAction = findBestReplacementNextToLeader(player);
    if (replacementAction) {
        console.log(`[AI DEBUG] Found replacement opportunity: ${replacementAction.newCard.value}${replacementAction.newCard.suit} replacing ${replacementAction.oldCard.value}${replacementAction.oldCard.suit}`);
        return replacementAction;
    }
    
    // CASE 3: Have 5 cards and no good replacement - skip summoning
    console.log(`[AI DEBUG] CASE 3: Have 5 cards and no better replacement found - skipping summoning to focus on movement/attacks`);
    return null;
}

// Helper function: Find best card to summon (CASE 1: less than 5 cards)
function findBestCardToSummon(player, allowEmptySpaces = true) {
    console.log(`[AI DEBUG] Finding best card to summon for player ${player}`);
    
    const leaderPos = findLeaderPosition(player);
    if (!leaderPos) return null;
    
    const hand = gameState.players[player].hand;
    if (hand.length === 0) return null;
    
    const neighbors = getHexNeighbors(leaderPos[0], leaderPos[1]);
    const validPositions = neighbors.filter(([r, c]) => {
        const existingCard = gameState.board[r][c];
        if (existingCard && existingCard.owner !== player) return false; // Enemy card
        if (!allowEmptySpaces && !existingCard) return false; // Only allow replacement
        return true;
    });
    
    if (validPositions.length === 0) return null;
    
    // Find the best card in hand based on total value (attack + defense)
    let bestCard = null;
    let bestValue = -1;
    
    for (const card of hand) {
        if (card.suit === 'joker') continue; // Skip leaders for now
        
        const cardValue = card.attack + card.defense;
        const cardPriority = getCardValuePriority(card);
        const totalScore = cardValue * 2 + cardPriority * 3; // Weight both stats and card value
        
        if (totalScore > bestValue) {
            bestValue = totalScore;
            bestCard = card;
        }
    }
    
    if (!bestCard) return null;
    
    // Find best position for this card
    let bestPosition = null;
    let bestPositionScore = -1;
    
    for (const [row, col] of validPositions) {
        let score = 50; // Base score
        
        // Prefer empty positions when expanding (less than 5 cards)
        const existingCard = gameState.board[row][col];
        if (!existingCard) {
            score += 100; // Big bonus for empty space
        } else {
            // Only replace if it's a significant upgrade
            const upgradeValue = (bestCard.attack + bestCard.defense) - (existingCard.attack + existingCard.defense);
            if (upgradeValue <= 0) {
                score -= 200; // Penalty for downgrade or equal
            } else {
                score += upgradeValue * 10; // Bonus for upgrade
            }
        }
        
        // Check immediate attack opportunities
        const attacks = getValidAttacks(bestCard, row, col);
        for (const [attackRow, attackCol] of attacks) {
            const target = gameState.board[attackRow][attackCol];
            if (target && target.owner !== player) {
                if (bestCard.attack >= target.defense) {
                    score += 30; // Bonus for capture opportunity
                    if (target.suit === 'joker') score += 100; // Huge bonus for leader capture
                }
            }
        }
        
        if (score > bestPositionScore) {
            bestPositionScore = score;
            bestPosition = [row, col];
        }
    }
    
    if (!bestPosition) return null;
    
    console.log(`[AI DEBUG] Best card to summon: ${bestCard.value}${bestCard.suit} to [${bestPosition[0]},${bestPosition[1]}] (score: ${bestPositionScore})`);
    
    return {
        card: bestCard,
        row: bestPosition[0],
        col: bestPosition[1]
    };
}

// Helper function: Find best replacement next to leader (CASE 2: have 5 cards)
function findBestReplacementNextToLeader(player) {
    console.log(`[AI DEBUG] Finding best replacement next to leader for player ${player}`);
    
    const leaderPos = findLeaderPosition(player);
    if (!leaderPos) return null;
    
    const hand = gameState.players[player].hand;
    if (hand.length === 0) return null;
    
    const neighbors = getHexNeighbors(leaderPos[0], leaderPos[1]);
    const adjacentCards = neighbors.filter(([r, c]) => {
        const card = gameState.board[r][c];
        return card && card.owner === player && card.suit !== 'joker'; // Our non-leader cards
    }).map(([r, c]) => ({ card: gameState.board[r][c], row: r, col: c }));
    
    if (adjacentCards.length === 0) {
        console.log(`[AI DEBUG] No cards adjacent to leader for replacement`);
        return null;
    }
    
    let bestReplacement = null;
    let bestUpgrade = 0;
    
    // Check each card in hand against each adjacent card
    for (const handCard of hand) {
        if (handCard.suit === 'joker') continue; // Skip leaders
        
        const handValue = handCard.attack + handCard.defense;
        
        for (const { card: adjacentCard, row, col } of adjacentCards) {
            const adjacentValue = adjacentCard.attack + adjacentCard.defense;
            const upgrade = handValue - adjacentValue;
            
            // Only consider if it's a meaningful upgrade (at least 2 points better)
            if (upgrade >= 2 && upgrade > bestUpgrade) {
                bestUpgrade = upgrade;
                bestReplacement = {
                    newCard: handCard,
                    oldCard: adjacentCard,
                    row: row,
                    col: col,
                    card: handCard // For compatibility with existing system
                };
            }
        }
    }
    
    if (bestReplacement) {
        console.log(`[AI DEBUG] Best replacement: ${bestReplacement.newCard.value}${bestReplacement.newCard.suit} (${bestReplacement.newCard.attack + bestReplacement.newCard.defense}) replacing ${bestReplacement.oldCard.value}${bestReplacement.oldCard.suit} (${bestReplacement.oldCard.attack + bestReplacement.oldCard.defense}) - upgrade: +${bestUpgrade}`);
    } else {
        console.log(`[AI DEBUG] No worthwhile replacements found (need at least +2 upgrade)`);
    }
    
    return bestReplacement;
}

function findBestCardReplacement(player) {
    // Only replace in play phase and if we have cards in hand
    if (gameState.phase !== 'play' || gameState.players[player].hand.length === 0) {
        return null;
    }
                    if (card.attack >= target.defense) {
                        captureOpportunities++;
                        captureValue += target.attack + target.defense;
                        
                        // Massive bonus for being able to capture enemy leader
                        if (target.suit === 'joker') {
                            score += 300; // Prioritize positions that can capture enemy leader

            
            // Bonus for cards with good defense (harder to capture)
            score += card.defense * 4;
            
            // CARD VALUE PRIORITY: Higher value cards should be summoned first
            const cardValuePriority = getCardValuePriority(card);
            score += cardValuePriority * 12; // Strong bonus for higher value cards
            console.log(`[AI DEBUG] Card ${card.value}${card.suit} value priority: ${cardValuePriority} (bonus: +${cardValuePriority * 12})`);
            
            // BOARD EXPANSION PRIORITY: When fewer than 5 cards, strongly prefer empty positions
            const cardToReplace = gameState.board[row][col];
            if (cardToReplace && cardToReplace.owner === player) {
                // This is a replacement
                const newCardValue = card.attack + card.defense;
                const oldCardValue = cardToReplace.attack + cardToReplace.defense;
                const upgradeValue = newCardValue - oldCardValue;
                
                // RULE 1: When we have fewer than 5 cards, almost never replace (VERY heavy penalty)
                if (mapCounts.totalCards < 5) {
                    score -= 300; // Massive penalty for replacing when we should expand
                    console.log(`[AI DEBUG] Board expansion mode: HEAVY penalizing replacement (${mapCounts.totalCards} < 5 cards)`);
                }
                
                // RULE 2: NEVER replace higher card with lower card (massive penalty)
                if (upgradeValue < 0) {
                    score -= 500; // Extreme penalty for downgrading
                    console.log(`[AI DEBUG] NEVER downgrade: blocking replacement of ${cardToReplace.value}${cardToReplace.suit} (${oldCardValue}) with weaker ${card.value}${card.suit} (${newCardValue})`);
                } else if (upgradeValue > 0) {
                    // Only allow replacement if it's a significant upgrade AND we have 5+ cards
                    if (mapCounts.totalCards >= 5 && upgradeValue >= 2) {
                        score += upgradeValue * 20; // Bonus for meaningful upgrading when at max cards
                        console.log(`[AI DEBUG] Meaningful upgrade allowed at max cards: +${upgradeValue} total value`);
                    } else if (upgradeValue < 2) {
                        score -= 50; // Penalty for minor upgrades
                        console.log(`[AI DEBUG] Minor upgrade not worth it: only +${upgradeValue} improvement`);
                    }
                } else {
                    // upgradeValue === 0, same value replacement
                    score -= 200; // Heavy penalty for same-value replacement
                    console.log(`[AI DEBUG] Same-value replacement blocked: no improvement`);
                }
                
                console.log(`[AI DEBUG] Replacement analysis at [${row},${col}]: ${card.value}${card.suit} (${newCardValue}) vs ${cardToReplace.value}${cardToReplace.suit} (${oldCardValue}), upgrade: ${upgradeValue}, totalCards: ${mapCounts.totalCards}`);
            } else {
                // This is summoning to an empty position
                if (mapCounts.totalCards < 5) {
                    score += 200; // Increased bonus for expanding the board
                    console.log(`[AI DEBUG] Board expansion mode: BIG bonus for empty position (${mapCounts.totalCards} < 5 cards)`);
                } else {
                    score += 30; // Standard bonus for board presence
                }
            }

            // DEFENSIVE: Check if this position will be safe
            const wouldBeThreatened = willCardBeThreatenedAtPosition(card, row, col, player);
            if (wouldBeThreatened) {
                score -= 40; // Penalty for dangerous positions
            } else {
                score += 20; // Bonus for safe positions
            }

            // PROTECT OUR CARDS: Bonus for positions that help defend our existing cards
            let defenseBonus = 0;
            for (let fr = 0; fr < 11; fr++) {
                for (let fc = 0; fc < 11; fc++) {
                    const friendlyCard = gameState.board[fr][fc];
                    if (friendlyCard && friendlyCard.owner === player) {
                        const distance = Math.abs(row - fr) + Math.abs(col - fc);
                        if (distance <= 2) { // Close to our existing cards
                            const threats = findThreatsToCard(friendlyCard, fr, fc, player);
                            if (threats.length > 0) {
                                defenseBonus += threats.length * 15; // Bonus for protecting threatened cards
                            }
                        }
                    }
                }
            }
            score += defenseBonus;

            // TACTICAL POSITIONING: Prefer positions that enable future captures
            let futureOpportunities = 0;
            const enemyCards = getAllEnemyCards(player);
            for (const enemyCard of enemyCards) {
                const distance = Math.abs(row - enemyCard.row) + Math.abs(col - enemyCard.col);
                if (distance <= 3) { // Within striking distance
                    if (card.attack >= enemyCard.card.defense) {
                        futureOpportunities++;
                    }
                }
            }
            score += futureOpportunities * 10;

            // AGGRESSION MODIFIER: Apply aggression-based bonuses for enemy-focused positioning
            const aggressionMod = getAggressionModifier(player);
            let aggressionBonus = 0;
            
            if (enemyCards.length > 0) {
                // Find distance to nearest enemy
                let minEnemyDistance = 999;
                let nearestEnemyLeader = null;
                
                for (const enemyCard of enemyCards) {
                    const distance = Math.abs(row - enemyCard.row) + Math.abs(col - enemyCard.col);
                    if (distance < minEnemyDistance) {
                        minEnemyDistance = distance;
                    }
                    if (enemyCard.card.suit === 'joker') {
                        nearestEnemyLeader = enemyCard;
                    }
                }
                
                // Aggressive positioning: closer to enemies = higher bonus with high aggression
                if (minEnemyDistance <= 3) {
                    const proximityBonus = (4 - minEnemyDistance) * 15; // Base bonus for being close to enemies
                    aggressionBonus += proximityBonus * (aggressionMod - 0.5); // Scale with aggression (0x to 2.25x)
                }
                
                // Special aggression bonus for positions near enemy leader
                if (nearestEnemyLeader) {
                    const leaderDistance = Math.abs(row - nearestEnemyLeader.row) + Math.abs(col - nearestEnemyLeader.col);
                    if (leaderDistance <= 4) {
                        const leaderProximityBonus = (5 - leaderDistance) * 20; // Base bonus for enemy leader proximity
                        aggressionBonus += leaderProximityBonus * (aggressionMod - 0.5); // Scale with aggression
                    }
                }
                
                console.log(`[AI DEBUG] Aggression bonus for ${card.value}${card.suit} at [${row},${col}]: +${Math.round(aggressionBonus)} (aggression: ${aiAggression[player]}, modifier: ${aggressionMod.toFixed(2)})`);
            }
            
            score += aggressionBonus;

            // FRONT-LINE FORMATION STRATEGY: Position cards in front of leader for protection
            const leaderPos = findLeaderPosition(player);
            if (leaderPos) {
                const [leaderRow, leaderCol] = leaderPos;
                
                // STRONG BIAS FOR FRONT-LINE POSITIONING
                const frontLineBonus = calculateFrontLineBonus(player, leaderPos, row, col);
                score += frontLineBonus;
                console.log(`[AI DEBUG] Front-line positioning bonus for ${card.value}${card.suit} at [${row},${col}]: +${frontLineBonus}`);
                
                const distanceToLeader = Math.abs(row - leaderRow) + Math.abs(col - leaderCol);
                
                // Different strategies for different suits
                if (card.suit === 'diamonds') {
                    // RULE 1: Diamonds should move FAR AWAY from leader to flank enemy leader
                    const enemyLeaderPos = findLeaderPosition(player === 1 ? 2 : 1);
                    
                    if (distanceToLeader >= 5) {
                        score += 80; // Strong bonus for being far from our leader
                    } else if (distanceToLeader >= 3) {
                        score += 50; // Good distance from leader
                    } else {
                        score -= 40; // Penalty for being too close to our leader
                    }
                    
                    // Huge bonus for positions that can threaten enemy leader
                    if (enemyLeaderPos) {
                        const distanceToEnemyLeader = Math.abs(row - enemyLeaderPos[0]) + Math.abs(col - enemyLeaderPos[1]);
                        
                        if (distanceToEnemyLeader <= 2) {
                            score += 120; // Massive bonus for positions that can attack enemy leader
                        } else if (distanceToEnemyLeader <= 4) {
                            score += 60; // Good bonus for positions near enemy leader
                        } else if (distanceToEnemyLeader <= 6) {
                            score += 30; // Moderate bonus for advancing toward enemy leader
                        }
                        
                        console.log(`[AI DEBUG] Diamond ${card.value}${card.suit} flanking enemy leader: distance to our leader=${distanceToLeader}, distance to enemy leader=${distanceToEnemyLeader}`);
                    }
                    
                    // Diamonds prefer NOT being crowded by other cards (independent operation)
                    const neighbors = getHexNeighbors(row, col);
                    const crowdedNeighbors = neighbors.filter(([r, c]) => {
                        const neighborCard = gameState.board[r][c];
                        return neighborCard && neighborCard.owner === player;
                    }).length;
                    
                    if (crowdedNeighbors === 0) {
                        score += 35; // Increased bonus for independent positioning
                    } else if (crowdedNeighbors >= 2) {
                        score -= 30; // Increased penalty for being too crowded
                    }
                    
                    console.log(`[AI DEBUG] Diamond ${card.value}${card.suit} independent flanking: distance from our leader=${distanceToLeader}, ${crowdedNeighbors} neighbors`);
                } else {
                    // RULE 2: Non-diamonds should be summoned around and in front of leader to protect it
                    
                    // MASSIVE bonus for being close to leader (protective positioning)
                    if (distanceToLeader === 1) {
                        score += 100; // Huge bonus for adjacent protection
                    } else if (distanceToLeader === 2) {
                        score += 80; // Very good close protection
                    } else if (distanceToLeader === 3) {
                        score += 60; // Good protective distance
                    } else if (distanceToLeader >= 4) {
                        score -= 50; // Penalty for being too far from leader
                    }
                    
                    // EXTRA bonus for being in front of leader (between leader and enemies)
                    if (isInFrontOfLeader(player, leaderPos, row, col)) {
                        score += 70; // Strong bonus for front-line protection
                        
                        // Even more bonus if close AND in front
                        if (distanceToLeader <= 2) {
                            score += 50; // Extra bonus for close front-line protection
                        }
                    } else {
                        // Being behind leader is still useful for protection, small penalty only
                        score -= 20; // Light penalty for behind leader (still protective)
                    }
                    
                    // Strong bonus for positions that can intercept attacks on leader
                    const enemyCards = getAllEnemyCards(player);
                    let interceptBonus = 0;
                    for (const enemyCard of enemyCards) {
                        const enemyToLeader = Math.abs(enemyCard.row - leaderRow) + Math.abs(enemyCard.col - leaderCol);
                        const enemyToCard = Math.abs(enemyCard.row - row) + Math.abs(enemyCard.col - col);
                        const cardToLeader = Math.abs(row - leaderRow) + Math.abs(col - leaderCol);
                        
                        // Bonus if this position intercepts path from enemy to leader
                        if (enemyToCard + cardToLeader <= enemyToLeader + 1) {
                            interceptBonus += 30;
                        }
                    }
                    score += interceptBonus;
                    
                    // Moderate bonus for positioning towards enemy formation (while staying protective)
                    if (enemyCards.length > 0) {
                        const enemyCenter = [
                            Math.round(enemyCards.reduce((sum, { row }) => sum + row, 0) / enemyCards.length),
                            Math.round(enemyCards.reduce((sum, { col }) => sum + col, 0) / enemyCards.length)
                        ];
                        
                        const leaderToEnemy = Math.abs(leaderRow - enemyCenter[0]) + Math.abs(leaderCol - enemyCenter[1]);
                        const cardToEnemy = Math.abs(row - enemyCenter[0]) + Math.abs(col - enemyCenter[1]);
                        
                        // Bonus for being positioned between leader and enemy (protective screen)
                        if (cardToEnemy < leaderToEnemy && distanceToLeader <= 3) {
                            score += 25; // Bonus for protective screening, but only if close to leader
                        }
                    }
                    
                    console.log(`[AI DEBUG] Protective formation bonus for ${card.value}${card.suit} at distance ${distanceToLeader} from leader, intercept bonus: +${interceptBonus}`);
                }
                
                // RULE 3: Enhanced formation cohesion for non-diamond cards
                if (isInFrontOfLeader(player, leaderPos, row, col)) {
                    const neighbors = getHexNeighbors(row, col);
                    const friendlyNeighbors = neighbors.filter(([r, c]) => {
                        const neighborCard = gameState.board[r][c];
                        return neighborCard && neighborCard.owner === player && neighborCard.suit !== 'joker';
                    });
                    
                    // Different bonuses for diamond vs non-diamond cards
                    if (card.suit === 'diamonds') {
                        // Diamonds get small cohesion bonus (they can work independently)
                        score += friendlyNeighbors.length * 15;
                    } else {
                        // Non-diamonds get large cohesion bonus (they should form tight formations)
                        score += friendlyNeighbors.length * 35;
                        
                        // Extra bonus for non-diamonds being close to other non-diamonds specifically
                        const nonDiamondNeighbors = friendlyNeighbors.filter(([r, c]) => {
                            const neighborCard = gameState.board[r][c];
                            return neighborCard.suit !== 'diamonds';
                        }).length;
                        
                        score += nonDiamondNeighbors * 25; // Additional formation bonus for non-diamonds
                        console.log(`[AI DEBUG] Non-diamond formation bonus for ${card.value}${card.suit}: ${friendlyNeighbors.length} total neighbors, ${nonDiamondNeighbors} non-diamond neighbors`);
                    }
                }
            }
            
            // LEADER PROTECTION PRIORITY: Bonus for positions that block threats to leader
            const threatVectors = calculateLeaderThreatVectors(player);
            let protectionBonus = 0;
            for (const threat of threatVectors) {
                // Check if this position would block the threat
                const leaderRow = leaderPos[0];
                const leaderCol = leaderPos[1];
                
                // Calculate if this position is on the line between threat and leader
                const threatToLeader = [leaderRow - threat.enemyRow, leaderCol - threat.enemyCol];
                const threatToCard = [row - threat.enemyRow, col - threat.enemyCol];
                
                // Check if card position is between threat and leader
                const threatDistance = Math.abs(threat.enemyRow - leaderRow) + Math.abs(threat.enemyCol - leaderCol);
                const cardToThreat = Math.abs(row - threat.enemyRow) + Math.abs(col - threat.enemyCol);
                const cardToLeader = Math.abs(row - leaderRow) + Math.abs(col - leaderCol);
                
                if (cardToThreat + cardToLeader <= threatDistance + 1) { // On or near the line
                    const blockingBonus = threat.canCurrentlyAttack ? 80 : 40; // Higher bonus for immediate threats
                    protectionBonus += blockingBonus;
                    console.log(`[AI DEBUG] Position [${row},${col}] blocks threat from [${threat.enemyRow},${threat.enemyCol}] - bonus: +${blockingBonus}`);
                }
            }
            score += protectionBonus;

            // Prefer central positions for better mobility (reduced weight for formation strategy)
            const distanceFromCenter = Math.abs(row - 5) + Math.abs(col - 5);
            score += (10 - distanceFromCenter) * 0.3; // Reduced from 0.5 to favor formation over center

            // Bonus if replacing a weaker card
            const existingCard = gameState.board[row][col];
            if (existingCard && existingCard.owner === player) {
                const cardValue = card.attack + card.defense;
                const existingValue = existingCard.attack + existingCard.defense;
                if (cardValue > existingValue) {
                    score += (cardValue - existingValue) * 3; // Replacement bonus
                }
            }

            // Add strategic randomization to summon decisions
            if (shouldRandomizeStrategy()) {
                score = addRandomNoise(score, 60); // Moderate noise for placement decisions
            }

            if (score > bestScore) {
                bestScore = score;
                bestAction = {
                    card: card,
                    row: row,
                    col: col
                };
            }
        }
    }

    // BEHAVIORAL REQUIREMENT: If less than 5 regular cards, ALWAYS summon regardless of score
    if (mustSummonDueToCardCount && bestAction) {
        console.log(`[AI DEBUG] MANDATORY SUMMON due to card count (${mapCounts.regularCards} < 5) - forcing summoning with score ${bestScore}`);
        return bestAction;
    }

    // Be very aggressive about summoning - very low threshold
    if (bestAction && bestScore > 1) {
        return bestAction;
    }

    // BEHAVIORAL REQUIREMENT: If less than 5 regular cards, force summoning even with fallback options
    if (mustSummonDueToCardCount && validSummonPositions.length > 0 && hand.length > 0) {
        console.log(`[AI DEBUG] FORCED FALLBACK SUMMON due to card count (${mapCounts.regularCards} < 5) - summoning strongest available card`);
        
        // Find the strongest card as mandatory summon
        const strongestCard = hand.reduce((best, card) => {
            const bestValue = best ? (best.attack + best.defense) : 0;
            const cardValue = card.attack + card.defense;
            return cardValue > bestValue ? card : best;
        }, null);
        
        if (strongestCard) {
            return {
                card: strongestCard,
                row: validSummonPositions[0][0],
                col: validSummonPositions[0][1]
            };
        }
    }

    // If we have cards in hand and valid positions, always try to summon something
    if (validSummonPositions.length > 0 && hand.length > 0) {
        // Find the strongest card as fallback
        const strongestCard = hand.reduce((best, card) => {
            const bestValue = best ? (best.attack + best.defense) : 0;
            const cardValue = card.attack + card.defense;
            return cardValue > bestValue ? card : best;
        }, null);
        
        if (strongestCard) {
            return {
                card: strongestCard,
                row: validSummonPositions[0][0],
                col: validSummonPositions[0][1]
            };
        }
    }

    return null;
}

function findBestCardReplacement(player) {
    // Only replace in play phase and if we have cards in hand
    if (gameState.phase !== 'play' || gameState.players[player].hand.length === 0) {
        return null;
    }
    
    // Check if leader has already been used this turn (one action per turn limit)
    if (gameState.leaderAttackedThisTurn) {
        console.log(`[AI DEBUG] Cannot replace cards - leader already used this turn`);
        return null;
    }
    
    // Get leader position (required for adjacency check)
    const leaderPos = findLeaderPosition(player);
    if (!leaderPos) {
        console.log(`[AI DEBUG] Cannot replace cards - no leader on board`);
        return null;
    }
    
    const [leaderRow, leaderCol] = leaderPos;
    const leaderNeighbors = getHexNeighbors(leaderRow, leaderCol);
    
    // Find player's cards that are ADJACENT TO LEADER only
    const playerCards = [];
    for (const [r, c] of leaderNeighbors) {
        const card = gameState.board[r][c];
        if (card && card.owner === player) {
            playerCards.push({ card, row: r, col: c });
        }
    }
    
    console.log(`[AI DEBUG] Found ${playerCards.length} cards adjacent to leader for potential replacement`)

    if (playerCards.length === 0) return null;

    // Check current board state - be much more conservative about replacements when < 5 cards
    const mapCounts = countCardsOnMap(player);
    if (mapCounts.regularCards < 5) {
        console.log(`[AI DEBUG] Board expansion mode (${mapCounts.regularCards} < 5 cards): being very conservative about replacements`);
        // Only allow replacement if it's a HUGE upgrade (to prioritize summoning to empty positions)
    }

    const hand = gameState.players[player].hand;
    let bestReplacement = null;
    let bestScore = -1;

    // Compare each card in hand with each card on board
    for (const handCard of hand) {
        for (const { card: boardCard, row, col } of playerCards) {
            // Don't replace leaders unless with another leader
            if (boardCard.suit === 'joker' && handCard.suit !== 'joker') {
                continue;
            }

            const handValue = handCard.attack + handCard.defense;
            const boardValue = boardCard.attack + boardCard.defense;
            
            // Only replace if the new card is significantly better
            const improvementScore = handValue - boardValue;
            if (improvementScore <= 0) continue;

            // CAPTURE-FOCUSED REPLACEMENT STRATEGY
            
            let score = improvementScore * 8; // Higher base score for better cards
            
            // CARD VALUE PRIORITY: Higher value cards are preferred for replacements too
            const handCardValuePriority = getCardValuePriority(handCard);
            const boardCardValuePriority = getCardValuePriority(boardCard);
            const valuePriorityDiff = handCardValuePriority - boardCardValuePriority;
            score += valuePriorityDiff * 8; // Bonus for replacing with higher value cards
            console.log(`[AI DEBUG] Replacement value priority: ${handCard.value}${handCard.suit} (${handCardValuePriority}) vs ${boardCard.value}${boardCard.suit} (${boardCardValuePriority}), diff: ${valuePriorityDiff}`);
            
            // BOARD EXPANSION: Heavy penalty for replacements when < 5 cards (should prioritize empty positions)
            if (mapCounts < 5) {
                score -= 80; // Substantial penalty to discourage replacements during expansion phase
                console.log(`[AI DEBUG] Board expansion penalty applied: -80 to replacement score (${mapCounts} < 5 cards)`);
            }

            // Check immediate capture opportunities the new card would have
            const attacksFromPosition = getValidAttacks(handCard, row, col);
            let captureOpportunities = 0;
            let captureValue = 0;
            
            for (const [attackRow, attackCol] of attacksFromPosition) {
                const target = gameState.board[attackRow][attackCol];
                if (target && target.owner !== player) {
                    if (handCard.attack >= target.defense) {
                        captureOpportunities++;
                        captureValue += target.attack + target.defense;
                        
                        // Huge bonus for replacing with cards that can capture enemy leader
                        if (target.suit === 'joker') {
                            score += 250;
                        }
                    }
                }
            }
            
            score += captureOpportunities * 40; // High priority for capture-capable replacements
            score += captureValue * 6;

            // Bonus for attack improvement (better at capturing)
            if (handCard.attack > boardCard.attack) {
                score += (handCard.attack - boardCard.attack) * 10;
            }
            
            // Bonus for defense improvement (harder to capture)
            if (handCard.defense > boardCard.defense) {
                score += (handCard.defense - boardCard.defense) * 8;
            }

            // SURVIVAL: Check if the replacement card would be safer
            const currentThreats = findThreatsToCard(boardCard, row, col, player);
            const newThreats = findThreatsToCard(handCard, row, col, player);
            
            const currentLethalThreats = currentThreats.filter(t => t.canCapture).length;
            const newLethalThreats = newThreats.filter(t => t.canCapture).length;
            
            if (newLethalThreats < currentLethalThreats) {
                score += (currentLethalThreats - newLethalThreats) * 30; // Bonus for safer replacements
            }

            // TACTICAL: Bonus for replacing cards in high-priority positions
            let tacticalBonus = 0;
            const enemyCards = getAllEnemyCards(player);
            for (const enemyCard of enemyCards) {
                const distance = Math.abs(row - enemyCard.row) + Math.abs(col - enemyCard.col);
                if (distance <= 2) { // Close to enemies
                    tacticalBonus += 15; // Important position bonus
                    
                    if (handCard.attack >= enemyCard.card.defense) {
                        tacticalBonus += 20; // Can capture nearby enemy
                    }
                }
            }
            score += tacticalBonus;

            if (score > bestScore) {
                bestScore = score;
                bestReplacement = {
                    oldCard: boardCard,
                    newCard: handCard,
                    row: row,
                    col: col
                };
            }
        }
    }

    // Dynamic threshold based on board state
    const threshold = mapCounts < 5 ? 100 : 5; // Much higher threshold when < 5 cards
    console.log(`[AI DEBUG] Replacement threshold: ${threshold} (${mapCounts} cards on board), best score: ${bestScore}`);
    
    // Only replace if there's a significant improvement
    if (bestReplacement && bestScore > threshold) {
        return bestReplacement;
    }

    return null;
}

function findEmergencyDefenseAction(player) {
    // Find cards that are about to be captured and can be moved to safety
    const myCards = [];
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && !isCardExhausted(card)) {
                myCards.push({ card, row: r, col: c });
            }
        }
    }

    let bestDefenseAction = null;
    let highestPriority = -1;

    for (const { card, row, col } of myCards) {
        const threats = findThreatsToCard(card, row, col, player);
        const lethalThreats = threats.filter(t => t.canCapture);
        
        if (lethalThreats.length > 0) {
            // This card is about to be captured! Try to move it to safety
            const validMoves = getValidMoves(card, row, col);
            
            for (const [newRow, newCol] of validMoves) {
                const newThreats = findThreatsToCard(card, newRow, newCol, player);
                const newLethalThreats = newThreats.filter(t => t.canCapture);
                
                if (newLethalThreats.length < lethalThreats.length) {
                    // This move reduces the danger to our card
                    let priority = (lethalThreats.length - newLethalThreats.length) * 50;
                    
                    // Higher priority for saving valuable cards
                    const cardValue = card.attack + card.defense;
                    priority += cardValue * 5;
                    
                    // MAXIMUM priority for saving the leader
                    if (card.suit === 'joker') {
                        priority += 300;
                    }
                    
                    // Bonus for moving to completely safe positions
                    if (newLethalThreats.length === 0) {
                        priority += 30;
                    }
                    
                    if (priority > highestPriority) {
                        highestPriority = priority;
                        bestDefenseAction = {
                            card,
                            fromRow: row,
                            fromCol: col,
                            toRow: newRow,
                            toCol: newCol,
                            threatsAvoided: lethalThreats.length - newLethalThreats.length
                        };
                    }
                }
            }
        }
    }

    // Only take emergency action if there's a significant threat (priority > 40)
    if (bestDefenseAction && highestPriority > 40) {
        return bestDefenseAction;
    }

    return null;
}

function replaceCard(row, col, newCard) {
    // This function replaces a card at a position with a new card from hand
    // It leverages the existing placeCard function which already handles replacement
    
    const existingCard = gameState.board[row][col];
    if (!existingCard || existingCard.owner !== newCard.owner) {
        console.log('Cannot replace card: invalid position or ownership');
        return false;
    }

    // Use the existing placeCard function which handles replacement automatically
    return placeCard(newCard, row, col);
}

function findAggressiveLeaderMove(player) {
    // Find the leader first
    const leaderPos = findLeaderPosition(player);
    if (!leaderPos) return null;

    const [leaderRow, leaderCol] = leaderPos;
    const leader = gameState.board[leaderRow][leaderCol];
    
    // Don't move if leader is exhausted
    if (isCardExhausted(leader)) return null;

    const validMoves = getValidMoves(leader, leaderRow, leaderCol);
    if (validMoves.length === 0) return null;

    let bestMove = null;
    let bestScore = -1;

    for (const [newRow, newCol] of validMoves) {
        let score = 0;

        // CAPTURE-FOCUSED LEADER STRATEGY
        
        // Check immediate capture opportunities from this position
        const futureAttacks = getValidAttacks(leader, newRow, newCol);
        let captureOpportunities = 0;
        let captureValue = 0;
        
        for (const [attackRow, attackCol] of futureAttacks) {
            const target = gameState.board[attackRow][attackCol];
            if (target && target.owner !== player) {
                if (leader.attack >= target.defense) {
                    captureOpportunities++;
                    captureValue += target.attack + target.defense;
                    
                    // MASSIVE bonus for leader vs leader combat opportunity
                    if (target.suit === 'joker') {
                        score += 400; // Leader capturing enemy leader is ultimate goal
                    } else {
                        score += 60; // Good bonus for any capture opportunity
                    }
                }
            }
        }
        
        score += captureOpportunities * 80; // High priority for capture positions
        score += captureValue * 5;

        // SURVIVAL: Check if this position is safe for the leader
        const wouldBeThreatened = willCardBeThreatenedAtPosition(leader, newRow, newCol, player);
        if (wouldBeThreatened) {
            // Check if the threat can actually capture our leader
            const threats = findThreatsToCard(leader, newRow, newCol, player);
            const lethalThreats = threats.filter(t => t.canCapture);
            
            if (lethalThreats.length > 0) {
                score -= 200; // Huge penalty for positions where leader can be captured
            } else {
                score -= 50; // Smaller penalty for positions where leader takes damage
            }
        } else {
            score += 30; // Bonus for safe positions
        }

        // TACTICAL: Move towards high-value targets we can potentially capture
        let bestTargetScore = 0;
        for (let er = 0; er < 11; er++) {
            for (let ec = 0; ec < 11; ec++) {
                const enemyCard = gameState.board[er][ec];
                if (enemyCard && enemyCard.owner !== player) {
                    const distance = Math.abs(newRow - er) + Math.abs(newCol - ec);
                    let targetValue = enemyCard.attack + enemyCard.defense;
                    
                    if (enemyCard.suit === 'joker') {
                        targetValue += 100; // Enemy leader is primary target
                    }
                    
                    // Score based on ability to reach and capture this target
                    if (leader.attack >= enemyCard.defense) {
                        const proximityScore = Math.max(0, 10 - distance) * targetValue * 0.1;
                        bestTargetScore = Math.max(bestTargetScore, proximityScore);
                    }
                }
            }
        }
        score += bestTargetScore;

        // Bonus for moving towards center (better overall positioning)
        const distanceFromCenter = Math.abs(newRow - 5) + Math.abs(newCol - 5);
        score += (10 - distanceFromCenter) * 0.8;

        if (score > bestScore) {
            bestScore = score;
            bestMove = {
                card: leader,
                fromRow: leaderRow,
                fromCol: leaderCol,
                toRow: newRow,
                toCol: newCol
            };
        }
    }

    // Be aggressive with leader movement - accept any move with decent potential (score > 8)
    if (bestMove && bestScore > 8) {
        return bestMove;
    }

    return null;
}

function findStrategicMoveAction(player) {
    // Get all player's cards on the board that can move (excluding leader)
    const playerCards = [];
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && !isCardExhausted(card) && card.suit !== 'joker') {
                playerCards.push({ card, row: r, col: c });
            }
        }
    }

    // Get leader positions for all movement calculations
    const leaderPos = findLeaderPosition(player);
    const enemyLeaderPos = findLeaderPosition(player === 1 ? 2 : 1);

    // RULE 3 & 4: Separate diamond and non-diamond movement strategies
    const nonDiamondCards = playerCards.filter(({ card }) => card.suit !== 'diamonds');
    const diamondCards = playerCards.filter(({ card }) => card.suit === 'diamonds');
    
    console.log(`[AI DEBUG] Strategic movement: ${nonDiamondCards.length} non-diamonds (formation), ${diamondCards.length} diamonds (flanking)`);

    let bestMove = null;
    let bestScore = -1;

    // RULE 2: Non-diamond cards move around and in front of leader to protect it
    for (const { card, row, col } of nonDiamondCards) {
        const validMoves = getValidMoves(card, row, col);
        if (validMoves.length === 0) continue;

        for (const [newRow, newCol] of validMoves) {
            let score = 0;

            // PRIORITY 1: Stay close to leader for protection
            if (leaderPos) {
                const distanceToLeader = Math.abs(newRow - leaderPos[0]) + Math.abs(newCol - leaderPos[1]);
                const currentDistanceToLeader = Math.abs(row - leaderPos[0]) + Math.abs(col - leaderPos[1]);
                
                // Massive bonus for being close to leader
                if (distanceToLeader === 1) {
                    score += 80; // Huge bonus for adjacent protection
                } else if (distanceToLeader === 2) {
                    score += 60; // Very good close protection
                } else if (distanceToLeader === 3) {
                    score += 40; // Good protective distance
                } else if (distanceToLeader >= 4) {
                    score -= 40; // Penalty for being too far from leader
                }
                
                // Bonus for moving closer to leader
                if (distanceToLeader < currentDistanceToLeader) {
                    score += 30; // Bonus for moving closer to leader
                }
                
                // HUGE bonus for positions in front of leader (protective screen)
                if (isInFrontOfLeader(player, leaderPos, newRow, newCol)) {
                    score += 70; // Strong bonus for front-line protection
                    
                    if (distanceToLeader <= 2) {
                        score += 40; // Extra bonus for close front-line protection
                    }
                }
                
                console.log(`[AI DEBUG] Leader protection movement for ${card.value}${card.suit}: distance to leader=${distanceToLeader}`);
            }

            // FORMATION COHESION: Moderate bonus for staying with other protectors
            let formationBonus = 0;
            let nearbyFriendlies = 0;
            for (const { card: otherCard, row: otherRow, col: otherCol } of nonDiamondCards) {
                if (otherCard === card) continue; // Skip self
                const distance = Math.abs(newRow - otherRow) + Math.abs(newCol - otherCol);
                if (distance <= 2) { // Within formation distance
                    formationBonus += (3 - distance) * 20; // Good bonus for protective formation
                    nearbyFriendlies++;
                }
            }
            score += formationBonus;

            // LEADER PROTECTION: Bonus for intercepting threats to leader
            const enemyCards = getAllEnemyCards(player);
            let interceptBonus = 0;
            if (leaderPos) {
                for (const enemyCard of enemyCards) {
                    const enemyToLeader = Math.abs(enemyCard.row - leaderPos[0]) + Math.abs(enemyCard.col - leaderPos[1]);
                    const enemyToCard = Math.abs(enemyCard.row - newRow) + Math.abs(enemyCard.col - newCol);
                    const cardToLeader = Math.abs(newRow - leaderPos[0]) + Math.abs(newCol - leaderPos[1]);
                    
                    // Strong bonus for intercepting paths to leader
                    if (enemyToCard + cardToLeader <= enemyToLeader + 1) {
                        interceptBonus += 40; // Strong interception bonus
                    }
                }
            }
            score += interceptBonus;

            // COMBINED ATTACK POTENTIAL: Bonus for attack opportunities while protecting
            const futureAttacks = getValidAttacks(card, newRow, newCol);
            for (const [targetRow, targetCol] of futureAttacks) {
                const target = gameState.board[targetRow][targetCol];
                if (target && target.owner !== player) {
                    score += 12; // Attack opportunity bonus
                    
                    // Check if other non-diamond cards can also attack this target
                    let combinedAttackers = 1;
                    for (const { card: allyCard, row: allyRow, col: allyCol } of nonDiamondCards) {
                        if (allyCard === card) continue;
                        const allyAttacks = getValidAttacks(allyCard, allyRow, allyCol);
                        if (allyAttacks.some(([ar, ac]) => ar === targetRow && ac === targetCol)) {
                            combinedAttackers++;
                        }
                    }
                    
                    if (combinedAttackers > 1) {
                        score += combinedAttackers * 15; // Bonus for combined attack potential
                    }
                }
            }

            // AGGRESSION MODIFIER: High aggression makes non-diamonds more willing to advance toward enemies
            const aggressionMod = getAggressionModifier(player);
            let aggressionBonus = 0;
            
            if (enemyCards.length > 0) {
                // Find distance to nearest enemy and enemy leader
                let minEnemyDistance = 999;
                let enemyLeaderDistance = 999;
                
                for (const enemyCard of enemyCards) {
                    const distance = Math.abs(newRow - enemyCard.row) + Math.abs(newCol - enemyCard.col);
                    if (distance < minEnemyDistance) {
                        minEnemyDistance = distance;
                    }
                    if (enemyCard.card.suit === 'joker') {
                        enemyLeaderDistance = distance;
                    }
                }
                
                // Aggressive formation movement: closer to enemies with high aggression
                if (minEnemyDistance <= 4) {
                    const proximityBonus = (5 - minEnemyDistance) * 10; // Base bonus for approaching enemies
                    aggressionBonus += proximityBonus * (aggressionMod - 0.8); // Scale with aggression (defensive at low aggression)
                }
                
                // Aggressive leader targeting: formations advance toward enemy leader
                if (enemyLeaderDistance <= 5) {
                    const leaderAdvanceBonus = (6 - enemyLeaderDistance) * 15; // Base bonus for approaching enemy leader
                    aggressionBonus += leaderAdvanceBonus * (aggressionMod - 0.8); // Scale with aggression
                }
                
                console.log(`[AI DEBUG] Non-diamond aggression bonus for ${card.value}${card.suit}: +${Math.round(aggressionBonus)} (aggression: ${aiAggression[player]})`);
            }
            
            score += aggressionBonus;

            // Bonus for high-value cards in protective formation
            score += card.attack * 2 + card.defense * 3; // Favor defensive cards for protection

            if (score > bestScore) {
                bestScore = score;
                bestMove = {
                    card,
                    fromRow: row,
                    fromCol: col,
                    toRow: newRow,
                    toCol: newCol,
                    moveType: 'leader_protection'
                };
            }
        }
    }

    // RULE 1: Diamond cards move FAR AWAY from leader to flank enemy leader
    for (const { card, row, col } of diamondCards) {
        const validMoves = getValidMoves(card, row, col);
        if (validMoves.length === 0) continue;

        for (const [newRow, newCol] of validMoves) {
            let score = 0;

            // PRIORITY 1: Move away from our leader
            if (leaderPos) {
                const distanceFromOurLeader = Math.abs(newRow - leaderPos[0]) + Math.abs(newCol - leaderPos[1]);
                const currentDistanceFromLeader = Math.abs(row - leaderPos[0]) + Math.abs(col - leaderPos[1]);
                
                if (distanceFromOurLeader > currentDistanceFromLeader) {
                    score += 40; // Bonus for moving away from our leader
                }
                
                if (distanceFromOurLeader >= 5) {
                    score += 60; // Strong bonus for being far from our leader
                } else if (distanceFromOurLeader >= 3) {
                    score += 30; // Good distance from our leader
                } else {
                    score -= 30; // Penalty for staying too close to our leader
                }
            }

            // PRIORITY 2: Move towards enemy leader for flanking attack
            if (enemyLeaderPos) {
                const distanceToEnemyLeader = Math.abs(newRow - enemyLeaderPos[0]) + Math.abs(newCol - enemyLeaderPos[1]);
                const currentDistanceToEnemyLeader = Math.abs(row - enemyLeaderPos[0]) + Math.abs(col - enemyLeaderPos[1]);
                
                if (distanceToEnemyLeader < currentDistanceToEnemyLeader) {
                    score += 50; // Bonus for moving closer to enemy leader
                }
                
                if (distanceToEnemyLeader <= 2) {
                    score += 100; // Huge bonus for positions that can attack enemy leader
                } else if (distanceToEnemyLeader <= 4) {
                    score += 60; // Good bonus for positions near enemy leader
                } else if (distanceToEnemyLeader <= 6) {
                    score += 25; // Moderate bonus for advancing toward enemy leader
                }
                
                console.log(`[AI DEBUG] Diamond movement toward enemy leader: distance=${distanceToEnemyLeader}, bonus applied`);
            }

            // Attack opportunities (especially against enemy leader)
            const futureAttacks = getValidAttacks(card, newRow, newCol);
            for (const [attackRow, attackCol] of futureAttacks) {
                const target = gameState.board[attackRow][attackCol];
                if (target && target.owner !== player) {
                    if (target.suit === 'joker') {
                        score += 150; // Massive bonus for attacking enemy leader
                    } else {
                        score += 15; // Regular attack bonus
                    }
                }
            }

            // AGGRESSION MODIFIER: High aggression makes diamonds extremely aggressive in enemy leader targeting
            const aggressionMod = getAggressionModifier(player);
            let diamondAggressionBonus = 0;
            
            if (enemyLeaderPos) {
                const distanceToEnemyLeader = Math.abs(newRow - enemyLeaderPos[0]) + Math.abs(newCol - enemyLeaderPos[1]);
                
                // Super aggressive diamond flanking with high aggression
                if (distanceToEnemyLeader <= 3) {
                    const directAssaultBonus = (4 - distanceToEnemyLeader) * 25; // Base bonus for direct assault
                    diamondAggressionBonus += directAssaultBonus * aggressionMod; // Full aggression scaling
                }
                
                // Bonus for moving closer to enemy leader with high aggression
                const currentDistance = Math.abs(row - enemyLeaderPos[0]) + Math.abs(col - enemyLeaderPos[1]);
                if (distanceToEnemyLeader < currentDistance) {
                    diamondAggressionBonus += 20 * aggressionMod; // Scale approach bonus with aggression
                }
                
                console.log(`[AI DEBUG] Diamond aggression bonus for ${card.value}${card.suit}: +${Math.round(diamondAggressionBonus)} (aggression: ${aiAggression[player]})`);
            }
            
            score += diamondAggressionBonus;

            // Strong independence bonus - diamonds should NOT cluster with formation
            let independenceBonus = 30; // Base independence bonus
            for (const { row: allyRow, col: allyCol } of nonDiamondCards) {
                const distance = Math.abs(newRow - allyRow) + Math.abs(newCol - allyCol);
                if (distance <= 1) {
                    independenceBonus -= 25; // Strong penalty for being adjacent to formation
                } else if (distance <= 2) {
                    independenceBonus -= 10; // Moderate penalty for being too close to formation
                }
            }
            score += independenceBonus;

            // Higher priority than before - diamonds should be very active, even more so with high aggression
            score *= (1.1 + (aggressionMod - 1.0) * 0.2); // Scale activity with aggression

            if (score > bestScore) {
                bestScore = score;
                bestMove = {
                    card,
                    fromRow: row,
                    fromCol: col,
                    toRow: newRow,
                    toCol: newCol,
                    moveType: 'diamond_enemy_leader_flanking'
                };
            }
        }
    }

    // Accept moves with ANY potential (score > 0) - BEHAVIORAL REQUIREMENT: cards should move around
    if (bestMove && bestScore > 0) {
        console.log(`[AI DEBUG] Strategic move selected: ${bestMove.card.value}${bestMove.card.suit} (${bestMove.moveType}) from [${bestMove.fromRow},${bestMove.fromCol}] to [${bestMove.toRow},${bestMove.toCol}] (score: ${bestScore})`);
        return bestMove;
    }

    return null;
}

function findBestMoveAction(player) {
    // This is now the fallback conservative movement function
    // Get all player's cards on the board that can move
    const playerCards = [];
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && !isCardExhausted(card)) {
                playerCards.push({ card, row: r, col: c });
            }
        }
    }

    // Only move if it might lead to a better attack position next turn
    // For now, be more conservative about moving - prioritize attacking and summoning
    for (const { card, row, col } of playerCards) {
        const validMoves = getValidMoves(card, row, col);
        if (validMoves.length > 0) {
            // Move towards center or towards enemies
            let bestMove = null;
            let bestScore = -1;
            
            for (const [newRow, newCol] of validMoves) {
                // Score based on potential future attacks from new position
                const futureAttacks = getValidAttacks(card, newRow, newCol);
                let score = futureAttacks.length;
                
                // Prefer moving towards center
                const distanceFromCenter = Math.abs(newRow - 5) + Math.abs(newCol - 5);
                score += (10 - distanceFromCenter) * 0.1;
                
                if (score > bestScore) {
                    bestScore = score;
                    bestMove = [newRow, newCol];
                }
            }
            
            // Accept ANY movement that has potential - BEHAVIORAL REQUIREMENT: cards should move around
            if (bestMove && bestScore >= 0) {
                return {
                    card,
                    fromRow: row,
                    fromCol: col,
                    toRow: bestMove[0],
                    toCol: bestMove[1]
                };
            }
        }
    }

    return null;
}

function performAISetupMove(player) {
    if (!aiEnabled[player] || gameState.currentPlayer !== player || gameState.phase !== 'setup') {
        return;
    }

    // Don't act if user is currently dragging or has cards selected
    if (isDraggingCard || gameState.selectedCard) {
        setTimeout(() => performAISetupMove(player), 300); // Try again later
        return;
    }

    console.log(`AI Player ${player} starting setup...`);
    performAISetupSequence(player);
}

function performAISetupSequence(player) {
    if (!aiEnabled[player] || gameState.currentPlayer !== player || gameState.phase !== 'setup') {
        return;
    }

    const playerData = gameState.players[player];
    const hasLeader = gameState.setupLeaderPlaced[player];
    const cardsPlaced = gameState.setupCardsPlaced[player];

    // Safety check: if we've already placed 6 cards, stop
    if (cardsPlaced >= 6) {
        console.log(`AI Player ${player} setup complete - already placed ${cardsPlaced} cards`);
        return;
    }

    // If we haven't placed a leader yet, place it first
    if (!hasLeader && playerData.hand.some(card => card.suit === 'joker')) {
        const leader = playerData.hand.find(card => card.suit === 'joker');
        // Find a good position for the leader in player's half
        const validPositions = [];
        const startRow = player === 1 ? 0 : 6;
        const endRow = player === 1 ? 4 : 10;
        
        for (let r = startRow; r <= endRow; r++) {
            for (let c = 0; c < 11; c++) {
                if (isValidHex(r, c) && !gameState.board[r][c]) {
                    validPositions.push([r, c]);
                }
            }
        }
        
        if (validPositions.length > 0) {
            // AGGRESSION-INFLUENCED LEADER PLACEMENT
            let chosenPos;
            const aggressionMod = getAggressionModifier(player);
            const rand = Math.random();
            
            // Higher aggression = more forward and aggressive leader placement
            const aggressiveThreshold = 0.3 + (aggressionMod - 1.0) * 0.4; // 0.3 to 0.9 based on aggression
            const defensiveThreshold = 0.7 - (aggressionMod - 1.0) * 0.2; // 0.7 to 0.4 based on aggression
            
            // Aggressive forward placement (higher chance with high aggression)
            if (rand < aggressiveThreshold) {
                // Forward positions (closer to enemy)
                const forwardPositions = validPositions.filter(([r, c]) => {
                    const distanceFromFront = player === 1 ? (4 - r) : (r - 6); // Distance from front line
                    return distanceFromFront <= 2; // Within 2 rows of front
                });
                
                if (forwardPositions.length > 0) {
                    chosenPos = forwardPositions[Math.floor(Math.random() * forwardPositions.length)];
                    console.log(`AI Player ${player} placing leader AGGRESSIVELY FORWARD at (${chosenPos[0]},${chosenPos[1]}) (aggression: ${aiAggression[player]})`);
                } else {
                    // Fallback to edge positions
                    const edgePositions = validPositions.filter(([r, c]) => c <= 2 || c >= 8);
                    if (edgePositions.length > 0) {
                        chosenPos = edgePositions[Math.floor(Math.random() * edgePositions.length)];
                        console.log(`AI Player ${player} placing leader AGGRESSIVELY at edge (${chosenPos[0]},${chosenPos[1]})`);
                    } else {
                        chosenPos = validPositions[Math.floor(Math.random() * validPositions.length)];
                    }
                }
            }
            // Defensive central placement (higher chance with low aggression)
            else if (rand < defensiveThreshold) {
                const centerPositions = validPositions.filter(([r, c]) => c >= 3 && c <= 7);
                if (centerPositions.length > 0) {
                    // With low aggression, prefer back positions for safety
                    const backCenterPositions = centerPositions.filter(([r, c]) => {
                        const distanceFromFront = player === 1 ? (4 - r) : (r - 6);
                        return distanceFromFront >= 2; // Away from front line
                    });
                    
                    if (backCenterPositions.length > 0 && aggressionMod < 1.2) {
                        chosenPos = backCenterPositions[Math.floor(Math.random() * backCenterPositions.length)];
                        console.log(`AI Player ${player} placing leader DEFENSIVELY in back-center (${chosenPos[0]},${chosenPos[1]}) (aggression: ${aiAggression[player]})`);
                    } else {
                        chosenPos = centerPositions[Math.floor(Math.random() * centerPositions.length)];
                        console.log(`AI Player ${player} placing leader DEFENSIVELY in center (${chosenPos[0]},${chosenPos[1]})`);
                    }
                } else {
                    chosenPos = validPositions[Math.floor(Math.random() * validPositions.length)];
                }
            }
            // Random placement fallback
            else {
                chosenPos = validPositions[Math.floor(Math.random() * validPositions.length)];
                console.log(`AI Player ${player} placing leader RANDOMLY at (${chosenPos[0]},${chosenPos[1]})`);
            }
            
            gameState.selectedCard = leader;
            handleSetupClick(chosenPos[0], chosenPos[1]);
            
            // Continue setup sequence after a short delay
            setTimeout(() => performAISetupSequence(player), 200);
            return;
        }
    }

    // Place regular cards if we have space - WITH MUCH MORE RANDOMNESS
    if (cardsPlaced < 6 && playerData.hand.length > 0) {
        const regularCards = playerData.hand.filter(card => card.suit !== 'joker');
        if (regularCards.length > 0) {
            // RANDOM CARD SELECTION instead of always strongest
            let cardToPlace;
            const strategy = Math.random();
            
            // 40% chance for completely random card selection
            if (strategy < 0.4) {
                cardToPlace = regularCards[Math.floor(Math.random() * regularCards.length)];
                console.log(`AI Player ${player} selecting RANDOM card: ${cardToPlace.value}${cardToPlace.suit}`);
            }
            // 30% chance for weakest card first (sacrifice strategy)
            else if (strategy < 0.7) {
                cardToPlace = regularCards.reduce((weakest, card) => {
                    if (!weakest || card.attack < weakest.attack) return card;
                    return weakest;
                }, regularCards[0]);
                console.log(`AI Player ${player} selecting WEAKEST card: ${cardToPlace.value}${cardToPlace.suit}`);
            }
            // 30% chance for traditional strongest card
            else {
                cardToPlace = regularCards.reduce((best, card) => {
                    if (!best || card.attack > best.attack) return card;
                    return best;
                }, regularCards[0]);
                console.log(`AI Player ${player} selecting STRONGEST card: ${cardToPlace.value}${cardToPlace.suit}`);
            }
            
            // DIFFERENTIAL POSITIONING STRATEGY based on card suit and aggression level
            const leaderPos = findLeaderPosition(player);
            let validPositions = [];
            let chosenPosition = null;
            const positionStrategy = Math.random();
            const aggressionMod = getAggressionModifier(player);
            
            // Get all valid positions in player's area
            const startRow = player === 1 ? 0 : 6;
            const endRow = player === 1 ? 4 : 10;
            const allValidPositions = [];
            
            for (let r = startRow; r <= endRow; r++) {
                for (let c = 0; c < 11; c++) {
                    if (isValidHex(r, c) && !gameState.board[r][c]) {
                        allValidPositions.push([r, c]);
                    }
                }
            }
            
            if (allValidPositions.length > 0 && leaderPos) {
                // RULE 1: Diamond cards should be placed FAR from leader (for flanking)
                if (cardToPlace.suit === 'diamonds') {
                    const farPositions = allValidPositions.filter(([r, c]) => {
                        const distanceFromLeader = Math.abs(r - leaderPos[0]) + Math.abs(c - leaderPos[1]);
                        return distanceFromLeader >= 4; // Far from leader
                    });
                    
                    if (farPositions.length > 0) {
                        chosenPosition = farPositions[Math.floor(Math.random() * farPositions.length)];
                        console.log(`AI Player ${player} placing DIAMOND FAR from leader at (${chosenPosition[0]},${chosenPosition[1]}) for flanking`);
                    } else {
                        // Fallback to any position if no far positions available
                        chosenPosition = allValidPositions[Math.floor(Math.random() * allValidPositions.length)];
                        console.log(`AI Player ${player} placing DIAMOND (fallback) at (${chosenPosition[0]},${chosenPosition[1]})`);
                    }
                }
                // RULE 2: Non-diamond cards should be placed AROUND and IN FRONT of leader (for protection)
                // AGGRESSION MODIFIER: Higher aggression prefers more forward/aggressive positioning
                else {
                    // Aggression influences positioning strategy
                    const aggressiveThreshold = 0.8 - (aggressionMod - 1.0) * 0.3; // More aggressive = more forward positioning
                    
                    if (positionStrategy < aggressiveThreshold) {
                        // Get protective positions, but with aggression-based distance preference
                        const maxDistance = aggressionMod > 1.2 ? 4 : 3; // More aggressive = willing to be further from leader
                        const protectivePositions = allValidPositions.filter(([r, c]) => {
                            const distanceFromLeader = Math.abs(r - leaderPos[0]) + Math.abs(c - leaderPos[1]);
                            return distanceFromLeader >= 1 && distanceFromLeader <= maxDistance;
                        });
                        
                        if (protectivePositions.length > 0) {
                            // Among protective positions, strongly prefer front positions with high aggression
                            const frontProtectivePositions = protectivePositions.filter(([r, c]) => {
                                return isInFrontOfLeader(player, leaderPos, r, c);
                            });
                            
                            // Aggression affects front-line preference
                            const frontLineChance = 0.6 + (aggressionMod - 1.0) * 0.3; // Higher aggression = more front-line preference
                            
                            if (frontProtectivePositions.length > 0 && Math.random() < frontLineChance) {
                                // With high aggression, prefer positions further forward
                                if (aggressionMod > 1.3) {
                                    // Sort by distance from starting edge (more forward = better)
                                    const sortedFront = frontProtectivePositions.sort(([r1, c1], [r2, c2]) => {
                                        const edge1 = player === 1 ? r1 : (10 - r1); // Distance from starting edge
                                        const edge2 = player === 1 ? r2 : (10 - r2);
                                        return edge2 - edge1; // Higher values first (further forward)
                                    });
                                    chosenPosition = sortedFront[0]; // Most forward position
                                    console.log(`AI Player ${player} placing NON-DIAMOND AGGRESSIVELY FORWARD at (${chosenPosition[0]},${chosenPosition[1]}) (aggression: ${aiAggression[player]})`);
                                } else {
                                    chosenPosition = frontProtectivePositions[Math.floor(Math.random() * frontProtectivePositions.length)];
                                    console.log(`AI Player ${player} placing NON-DIAMOND in FRONT-PROTECTIVE position at (${chosenPosition[0]},${chosenPosition[1]})`);
                                }
                            } else {
                                chosenPosition = protectivePositions[Math.floor(Math.random() * protectivePositions.length)];
                                console.log(`AI Player ${player} placing NON-DIAMOND in PROTECTIVE position at (${chosenPosition[0]},${chosenPosition[1]})`);
                            }
                        }
                    }
                    // Adjacent positioning (influenced by aggression)
                    else {
                        const neighbors = getHexNeighbors(leaderPos[0], leaderPos[1]);
                        const adjacentPositions = neighbors.filter(([r, c]) => isValidHex(r, c) && !gameState.board[r][c]);
                        if (adjacentPositions.length > 0) {
                            chosenPosition = adjacentPositions[Math.floor(Math.random() * adjacentPositions.length)];
                            console.log(`AI Player ${player} placing NON-DIAMOND ADJACENT to leader at (${chosenPosition[0]},${chosenPosition[1]})`);
                        }
                    }
                }
                
                // If no position chosen yet, use fallback strategy
                if (!chosenPosition) {
                    if (!leaderPos) {
                        // If no leader exists yet, prefer forward positions (towards enemy)
                        const forwardPositions = allValidPositions.filter(([r, c]) => {
                            // For Player 1: prefer higher row numbers (towards Player 2)
                            // For Player 2: prefer lower row numbers (towards Player 1)
                            if (player === 1) {
                                return r >= 2; // Prefer forward half of player's area
                            } else {
                                return r <= 8; // Prefer forward half of player's area
                            }
                        });
                        
                        if (forwardPositions.length > 0) {
                            chosenPosition = forwardPositions[Math.floor(Math.random() * forwardPositions.length)];
                            console.log(`AI Player ${player} placing in FORWARD position (no leader yet) at (${chosenPosition[0]},${chosenPosition[1]})`);
                        }
                    } else {
                        // 5% chance for random positioning (variety)
                        chosenPosition = allValidPositions[Math.floor(Math.random() * allValidPositions.length)];
                        console.log(`AI Player ${player} using RANDOM positioning at (${chosenPosition[0]},${chosenPosition[1]})`);
                    }
                }
                
                // Fallback to random position if no strategy worked
                if (!chosenPosition) {
                    chosenPosition = allValidPositions[Math.floor(Math.random() * allValidPositions.length)];
                    console.log(`AI Player ${player} using FALLBACK positioning at (${chosenPosition[0]},${chosenPosition[1]})`);
                }
                
                gameState.selectedCard = cardToPlace;
                handleSetupClick(chosenPosition[0], chosenPosition[1]);
                
                // Continue setup sequence after a short delay
                setTimeout(() => performAISetupSequence(player), 200);
                return;
            }
        }
    }

    // If we can't place more cards, the setup will auto-advance
    console.log(`AI Player ${player} setup complete - placed ${cardsPlaced} cards`);
}

let hoveredHex = null; // Track which hex is being hovered
let hoveredAttackTarget = null; // Track hovered attack target
let attackPreviewResults = null; // Store attack results for preview

// Mobile hover state for attack-only tap-to-hover
let mobileHoveredHex = null; // Track mobile tap hover hex
let isMobileHovering = false; // Track if in mobile hover state

// Mobile multi-select state 
let isMobileMultiSelectMode = false; // Track if in mobile multi-select mode

// Global touch device detection
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// Hand card summoning state
let validDiscards = []; // Track positions where cards will be discarded during replacement

// Drag functionality - unified drag system
let dragState = {
    isDragging: false,
    dragType: null, // 'hand-summon', 'card-move', 'card-attack', 'map'
    draggedCard: null,
    startX: 0,
    startY: 0,
    startHex: null,
    currentHex: null,
    mapStartX: 0,
    mapStartY: 0,
    originalSelection: null // Store original selection state during drag
};

// Legacy compatibility (will be removed)
let isDraggingCard = false;
let isDraggingMap = false;
let draggedCard = null;

// Performance optimization for drag rendering
let dragUpdateRequested = false;
let lastMousePos = null;

// LocalStorage functions for game persistence
function saveGameState() {
    try {
        // Convert Set to Array and Map to Object for JSON serialization
        const gameStateToSave = {
            ...gameState,
            cardsMovedThisTurn: Array.from(gameState.cardsMovedThisTurn),
            cardsAttackedThisTurn: Array.from(gameState.cardsAttackedThisTurn),
            cardsAttackExhaustion: Object.fromEntries(gameState.cardsAttackExhaustion),
            mapRotated: mapRotated, // Save map rotation state
            mapFlippingEnabled: mapFlippingEnabled, // Save map flipping setting
            aiEnabled: aiEnabled, // Save AI player settings
            zoomLevel: zoomLevel, // Save zoom level
            boardOffsetX: boardOffsetX, // Save map position
            boardOffsetY: boardOffsetY
        };
        localStorage.setItem('tcg-game-state', JSON.stringify(gameStateToSave));
    } catch (error) {
        console.warn('Failed to save game state:', error);
    }
}

function loadGameState() {
    try {
        const savedState = localStorage.getItem('tcg-game-state');
        if (savedState) {
            const parsedState = JSON.parse(savedState);
            // Convert Array back to Set and Object back to Map
            parsedState.cardsMovedThisTurn = new Set(parsedState.cardsMovedThisTurn || []);
            parsedState.cardsAttackedThisTurn = new Set(parsedState.cardsAttackedThisTurn || []);
            parsedState.cardsAttackExhaustion = new Map(Object.entries(parsedState.cardsAttackExhaustion || {}));
            // Restore map rotation state
            if (parsedState.mapRotated !== undefined) {
                mapRotated = parsedState.mapRotated;
            }
            // Restore map flipping setting
            if (parsedState.mapFlippingEnabled !== undefined) {
                mapFlippingEnabled = parsedState.mapFlippingEnabled;
            }
            // AI player settings are NOT restored from saved state
            // They always default to P1 human vs P2 AI on page reload
            // (AI settings are preserved only within the same session via "New Game")
            // Restore zoom level and map position
            if (parsedState.zoomLevel !== undefined) {
                zoomLevel = parsedState.zoomLevel;
                hexSize = baseHexSize * zoomLevel;
                hexWidth = hexSize * 2;
                hexHeight = hexSize * Math.sqrt(3);
            }
            if (parsedState.boardOffsetX !== undefined) {
                boardOffsetX = parsedState.boardOffsetX;
            }
            if (parsedState.boardOffsetY !== undefined) {
                boardOffsetY = parsedState.boardOffsetY;
            }
            // Ensure selectedCards is properly initialized for older save states
            if (!parsedState.selectedCards) {
                parsedState.selectedCards = [];
            }
            // Ensure setupLeaderPlaced is properly initialized for older save states
            if (!parsedState.setupLeaderPlaced) {
                parsedState.setupLeaderPlaced = { 1: false, 2: false };
                // Check if leaders are already placed on the board to update tracking
                for (let r = 0; r < 11; r++) {
                    for (let c = 0; c < 11; c++) {
                        const card = parsedState.board[r][c];
                        if (card && card.suit === 'joker') {
                            parsedState.setupLeaderPlaced[card.owner] = true;
                        }
                    }
                }
            }
            return parsedState;
        }
    } catch (error) {
        console.warn('Failed to load game state:', error);
    }
    return null;
}

// History management for undo functionality
function saveStateToHistory() {
    // Create a deep copy of the current game state
    const stateCopy = {
        ...gameState,
        cardsMovedThisTurn: new Set(gameState.cardsMovedThisTurn),
        cardsAttackedThisTurn: new Set(gameState.cardsAttackedThisTurn),
        cardsAttackExhaustion: new Map(gameState.cardsAttackExhaustion),
        board: gameState.board.map(row => [...row]), // Deep copy the board
        players: {
            1: {
                ...gameState.players[1],
                hand: [...gameState.players[1].hand],
                captured: [...gameState.players[1].captured],
                discarded: [...gameState.players[1].discarded],
                deck: [...gameState.players[1].deck]
            },
            2: {
                ...gameState.players[2],
                hand: [...gameState.players[2].hand],
                captured: [...gameState.players[2].captured],
                discarded: [...gameState.players[2].discarded],
                deck: [...gameState.players[2].deck]
            }
        },
        selectedCards: [...gameState.selectedCards]
    };
    
    // Add to history
    gameHistory.push(stateCopy);
    
    // Limit history size
    if (gameHistory.length > MAX_HISTORY_SIZE) {
        gameHistory.shift(); // Remove oldest state
    }
}

function undoLastMove() {
    // Block undo if current player is AI controlled
    if (aiEnabled[gameState.currentPlayer]) {
        console.log('Undo not allowed during AI turn');
        return false;
    }
    
    if (gameHistory.length === 0) {
        console.log('No moves to undo');
        return false;
    }
    
    // Restore the last saved state
    const previousState = gameHistory.pop();
    
    // Restore game state
    gameState.currentPlayer = previousState.currentPlayer;
    gameState.phase = previousState.phase;
    gameState.turn = previousState.turn;
    gameState.board = previousState.board.map(row => [...row]); // Deep copy
    gameState.players = {
        1: {
            ...previousState.players[1],
            hand: [...previousState.players[1].hand],
            captured: [...previousState.players[1].captured],
            discarded: [...previousState.players[1].discarded],
            deck: [...previousState.players[1].deck]
        },
        2: {
            ...previousState.players[2],
            hand: [...previousState.players[2].hand],
            captured: [...previousState.players[2].captured],
            discarded: [...previousState.players[2].discarded],
            deck: [...previousState.players[2].deck]
        }
    };
    gameState.setupStep = previousState.setupStep;
    gameState.setupCardsPlaced = { ...previousState.setupCardsPlaced };
    gameState.setupLeaderPlaced = { ...previousState.setupLeaderPlaced };
    gameState.leaderAttackedThisTurn = previousState.leaderAttackedThisTurn;
    gameState.cardsMovedThisTurn = new Set(previousState.cardsMovedThisTurn);
    gameState.cardsAttackedThisTurn = new Set(previousState.cardsAttackedThisTurn);
    gameState.cardsAttackExhaustion = new Map(previousState.cardsAttackExhaustion || []);
    
    // Clear current selections
    clearSelection();
    
    // Update UI and canvas
    updateCanvas();
    updateUI();
    saveGameState(); // Save the restored state to localStorage
    
    console.log('Move undone');
    return true;
}

function clearSavedGame() {
    try {
        localStorage.removeItem('tcg-game-state');
    } catch (error) {
        console.warn('Failed to clear saved game:', error);
    }
}

// FRONT-LINE FORMATION STRATEGY FUNCTIONS

// Analyze current formation and identify front-line needs
function analyzeFormationNeeds(player) {
    const playerCards = [];
    const enemyCards = [];
    const leaderPos = findLeaderPosition(player);
    const enemyPlayer = player === 1 ? 2 : 1;
    
    // Collect all cards
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player) {
                playerCards.push({ card, row: r, col: c });
            } else if (card && card.owner === enemyPlayer) {
                enemyCards.push({ card, row: r, col: c });
            }
        }
    }
    
    if (!leaderPos || playerCards.length === 0) {
        return { needsFrontLine: true, frontLineCards: [], supportCards: [], enemyCenter: null };
    }
    
    const [leaderRow, leaderCol] = leaderPos;
    
    // Calculate enemy formation center
    let enemyCenter = null;
    if (enemyCards.length > 0) {
        const avgRow = enemyCards.reduce((sum, { row }) => sum + row, 0) / enemyCards.length;
        const avgCol = enemyCards.reduce((sum, { col }) => sum + col, 0) / enemyCards.length;
        enemyCenter = [Math.round(avgRow), Math.round(avgCol)];
    }
    
    // Classify cards as front-line or support based on position relative to leader and enemy
    const frontLineCards = [];
    const supportCards = [];
    
    for (const { card, row, col } of playerCards) {
        if (card.suit === 'joker') continue; // Skip leader
        
        const distanceToLeader = Math.abs(row - leaderRow) + Math.abs(col - leaderCol);
        
        // Check if card is positioned between leader and enemies (front-line)
        let isFrontLine = false;
        if (enemyCenter) {
            const leaderToEnemy = Math.abs(leaderRow - enemyCenter[0]) + Math.abs(leaderCol - enemyCenter[1]);
            const cardToEnemy = Math.abs(row - enemyCenter[0]) + Math.abs(col - enemyCenter[1]);
            const cardToLeader = distanceToLeader;
            
            // Front-line if closer to enemy than leader is, or positioned defensively in front
            isFrontLine = (cardToEnemy < leaderToEnemy) || (cardToLeader >= 2 && cardToLeader <= 4);
        } else {
            // No enemies found, consider cards 2-4 hexes from leader as front-line
            isFrontLine = distanceToLeader >= 2 && distanceToLeader <= 4;
        }
        
        if (isFrontLine) {
            frontLineCards.push({ card, row, col });
        } else {
            supportCards.push({ card, row, col });
        }
    }
    
    // Determine if we need more front-line cards
    const needsFrontLine = frontLineCards.length < Math.min(3, playerCards.length - 1); // Want at least 3 front-line cards
    
    return {
        needsFrontLine,
        frontLineCards,
        supportCards,
        enemyCenter,
        leaderPos: [leaderRow, leaderCol]
    };
}

// Find best movement for front-line formation strategy
function findFrontLineFormationMove(player) {
    const formation = analyzeFormationNeeds(player);
    const enemyPlayer = player === 1 ? 2 : 1;
    
    if (!formation.leaderPos) return null;
    
    const [leaderRow, leaderCol] = formation.leaderPos;
    
    // Priority 1: Move support cards to front-line positions
    if (formation.needsFrontLine && formation.supportCards.length > 0) {
        console.log(`[AI DEBUG] Formation needs front-line cards (${formation.frontLineCards.length} < 3)`);
        
        for (const { card, row, col } of formation.supportCards) {
            if (isCardExhausted(card) || card.suit === 'diamonds') continue; // Skip exhausted cards and diamonds
            
            const validMoves = getValidMoves(card, row, col);
            let bestFrontLineMove = null;
            let bestScore = -1;
            
            for (const [newRow, newCol] of validMoves) {
                let score = 0;
                
                // Check if this position is more forward (towards enemy or away from leader)
                const newDistanceToLeader = Math.abs(newRow - leaderRow) + Math.abs(newCol - leaderCol);
                const currentDistanceToLeader = Math.abs(row - leaderRow) + Math.abs(col - leaderCol);
                
                // Bonus for moving further from leader (forward position)
                if (newDistanceToLeader > currentDistanceToLeader) {
                    score += (newDistanceToLeader - currentDistanceToLeader) * 20;
                }
                
                // Bonus for good front-line distance (2-4 hexes from leader)
                if (newDistanceToLeader >= 2 && newDistanceToLeader <= 4) {
                    score += 40;
                } else if (newDistanceToLeader > 4) {
                    score -= 10; // Don't go too far
                }
                
                // Bonus for positioning towards enemy formation
                if (formation.enemyCenter) {
                    const enemyDistance = Math.abs(newRow - formation.enemyCenter[0]) + Math.abs(newCol - formation.enemyCenter[1]);
                    const leaderEnemyDistance = Math.abs(leaderRow - formation.enemyCenter[0]) + Math.abs(leaderCol - formation.enemyCenter[1]);
                    
                    // Bonus for being positioned between leader and enemy
                    if (enemyDistance < leaderEnemyDistance) {
                        score += 30;
                    }
                }
                
                // Bonus for cohesion with other front-line cards
                const neighbors = getHexNeighbors(newRow, newCol);
                const friendlyNeighbors = neighbors.filter(([r, c]) => {
                    const neighborCard = gameState.board[r][c];
                    return neighborCard && neighborCard.owner === player && neighborCard.suit !== 'joker';
                }).length;
                score += friendlyNeighbors * 15;
                
                // Safety check
                const wouldBeSafe = !willCardBeThreatenedAtPosition(card, newRow, newCol, player);
                if (!wouldBeSafe) {
                    score -= 50; // Penalty for dangerous positions
                }
                
                if (score > bestScore) {
                    bestScore = score;
                    bestFrontLineMove = [newRow, newCol];
                }
            }
            
            if (bestFrontLineMove && bestScore > 20) {
                console.log(`[AI DEBUG] Moving ${card.value}${card.suit} to front-line position [${bestFrontLineMove[0]},${bestFrontLineMove[1]}] (score: ${bestScore})`);
                return {
                    type: 'front_line_formation',
                    card: card,
                    fromRow: row,
                    fromCol: col,
                    toRow: bestFrontLineMove[0],
                    toCol: bestFrontLineMove[1]
                };
            }
        }
    }
    
    // Priority 2: Improve front-line cohesion (group front-line cards together)
    const isolatedFrontLine = formation.frontLineCards.filter(({ card, row, col }) => {
        if (isCardExhausted(card)) return false;
        
        const neighbors = getHexNeighbors(row, col);
        const friendlyNeighbors = neighbors.filter(([r, c]) => {
            const neighborCard = gameState.board[r][c];
            return neighborCard && neighborCard.owner === player && neighborCard.suit !== 'joker';
        }).length;
        
        return friendlyNeighbors <= 1; // Isolated if 1 or fewer friendly neighbors
    });
    
    if (isolatedFrontLine.length > 0) {
        console.log(`[AI DEBUG] ${isolatedFrontLine.length} front-line cards need better cohesion`);
        
        for (const { card, row, col } of isolatedFrontLine) {
            const validMoves = getValidMoves(card, row, col);
            let bestCohesionMove = null;
            let bestCohesionScore = -1;
            
            for (const [newRow, newCol] of validMoves) {
                // Count friendly neighbors at new position
                const neighbors = getHexNeighbors(newRow, newCol);
                const friendlyNeighbors = neighbors.filter(([r, c]) => {
                    const neighborCard = gameState.board[r][c];
                    return neighborCard && neighborCard.owner === player && neighborCard.suit !== 'joker';
                }).length;
                
                // Maintain front-line distance from leader
                const distanceToLeader = Math.abs(newRow - leaderRow) + Math.abs(newCol - leaderCol);
                let score = friendlyNeighbors * 25;
                
                if (distanceToLeader >= 2 && distanceToLeader <= 4) {
                    score += 20; // Bonus for maintaining front-line distance
                }
                
                const wouldBeSafe = !willCardBeThreatenedAtPosition(card, newRow, newCol, player);
                if (!wouldBeSafe) {
                    score -= 30;
                }
                
                if (score > bestCohesionScore) {
                    bestCohesionScore = score;
                    bestCohesionMove = [newRow, newCol];
                }
            }
            
            if (bestCohesionMove && bestCohesionScore >= 30) {
                console.log(`[AI DEBUG] Improving front-line cohesion: ${card.value}${card.suit} to [${bestCohesionMove[0]},${bestCohesionMove[1]}] (score: ${bestCohesionScore})`);
                return {
                    type: 'front_line_cohesion',
                    card: card,
                    fromRow: row,
                    fromCol: col,
                    toRow: bestCohesionMove[0],
                    toCol: bestCohesionMove[1]
                };
            }
        }
    }
    
    return null;
}

// Enhanced diamond flanking strategy - target breaking enemy formations from behind
function findDiamondFlankingMove(player) {
    const enemyPlayer = player === 1 ? 2 : 1;
    const playerCards = [];
    const enemyCards = [];
    
    // Find diamond cards and enemy formation
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && card.suit === 'diamonds' && !isCardExhausted(card)) {
                playerCards.push({ card, row: r, col: c });
            } else if (card && card.owner === enemyPlayer) {
                enemyCards.push({ card, row: r, col: c });
            }
        }
    }
    
    // BEHAVIORAL REQUIREMENT: Diamond cards should always move around to flank the enemy leader from behind
    // Even if no enemies present, diamonds should still reposition for optimal flanking
    if (playerCards.length === 0) return null;
    
    // Find enemy leader and formation center
    let enemyLeaderPos = null;
    for (const { card, row, col } of enemyCards) {
        if (card.suit === 'joker') {
            enemyLeaderPos = [row, col];
            break;
        }
    }
    
    // Calculate enemy formation center
    const enemyCenter = [
        Math.round(enemyCards.reduce((sum, { row }) => sum + row, 0) / enemyCards.length),
        Math.round(enemyCards.reduce((sum, { col }) => sum + col, 0) / enemyCards.length)
    ];
    
    console.log(`[AI DEBUG] Diamond flanking analysis: ${playerCards.length} diamonds, enemy center at [${enemyCenter[0]},${enemyCenter[1]}], leader at ${enemyLeaderPos}`);
    
    for (const { card, row, col } of playerCards) {
        const validMoves = getValidMoves(card, row, col);
        let bestFlankMove = null;
        let bestFlankScore = -1;
        
        for (const [newRow, newCol] of validMoves) {
            let flankScore = 0;
            
            // Priority 1: RULE 4 - Position BEHIND enemy formation to flank from behind
            let behindFormationBonus = 0;
            
            // Determine what "behind" means for the enemy
            // Enemy player 1 territory is rows 0-4, so "behind" is rows 0-1
            // Enemy player 2 territory is rows 6-10, so "behind" is rows 9-10
            const isFlankingFromBehind = (enemyPlayer === 1 && newRow <= 1) || (enemyPlayer === 2 && newRow >= 9);
            
            if (isFlankingFromBehind) {
                behindFormationBonus += 60; // Strong bonus for flanking from behind enemy territory
                console.log(`[AI DEBUG] Diamond flanking from behind enemy territory at [${newRow},${newCol}]`);
            }
            
            // Additional check: position behind enemy leader specifically
            if (enemyLeaderPos) {
                const leaderRow = enemyLeaderPos[0];
                const isBehindLeader = (enemyPlayer === 1 && newRow < leaderRow) || (enemyPlayer === 2 && newRow > leaderRow);
                
                if (isBehindLeader) {
                    behindFormationBonus += 40; // Extra bonus for being behind enemy leader
                    console.log(`[AI DEBUG] Diamond positioning behind enemy leader`);
                }
                
                // Bonus for being on opposite side of enemy center from their starting position
                const enemyCenterRow = enemyCenter[0];
                const playerStartingSide = enemyPlayer === 1 ? 0 : 10; // Enemy's starting edge
                const oppositeSide = enemyPlayer === 1 ? 10 : 0; // Opposite edge (behind them)
                
                const distanceToOppositeSide = Math.abs(newRow - oppositeSide);
                const distanceToStartingSide = Math.abs(newRow - playerStartingSide);
                
                if (distanceToOppositeSide < distanceToStartingSide) {
                    behindFormationBonus += 30; // Flanking from the back side
                }
            }
            
            flankScore += behindFormationBonus;
            
            // Priority 2: Target positions that can attack multiple enemy cards (break formation)
            let breakFormationScore = 0;
            const futureAttacks = getValidAttacks(card, newRow, newCol);
            const attackableEnemies = [];
            
            for (const [attackRow, attackCol] of futureAttacks) {
                const target = gameState.board[attackRow][attackCol];
                if (target && target.owner === enemyPlayer && card.attack >= target.defense) {
                    attackableEnemies.push(target);
                    breakFormationScore += target.attack + target.defense;
                    
                    // Massive bonus for attacking enemy leader from behind
                    if (target.suit === 'joker') {
                        breakFormationScore += 100;
                    }
                    
                    // Bonus for attacking multiple enemies (breaks formation cohesion)
                    if (attackableEnemies.length > 1) {
                        breakFormationScore += 30;
                    }
                }
            }
            flankScore += breakFormationScore;
            
            // Priority 3: Distance optimization for flanking
            const distanceToEnemyCenter = Math.abs(newRow - enemyCenter[0]) + Math.abs(newCol - enemyCenter[1]);
            if (distanceToEnemyCenter >= 1 && distanceToEnemyCenter <= 3) {
                flankScore += 25; // Optimal flanking distance
            } else if (distanceToEnemyCenter > 5) {
                flankScore -= 20; // Too far to be effective
            }
            
            // Priority 4: Disruption potential - position to threaten enemy formation integrity
            let disruptionScore = 0;
            for (const { card: enemyCard, row: er, col: ec } of enemyCards) {
                const distanceToEnemy = Math.abs(newRow - er) + Math.abs(newCol - ec);
                if (distanceToEnemy <= 2) {
                    // Close enough to threaten enemy card next turn
                    disruptionScore += 10;
                    
                    // Extra bonus if enemy card is supporting their formation (has friendly neighbors)
                    const enemyNeighbors = getHexNeighbors(er, ec);
                    const enemySupport = enemyNeighbors.filter(([r, c]) => {
                        const supportCard = gameState.board[r][c];
                        return supportCard && supportCard.owner === enemyPlayer;
                    }).length;
                    
                    if (enemySupport >= 2) {
                        disruptionScore += 15; // Bonus for disrupting well-supported enemy cards
                    }
                }
            }
            flankScore += disruptionScore;
            
            // Safety consideration (but less important for flanking maneuvers)
            const wouldBeSafe = !willCardBeThreatenedAtPosition(card, newRow, newCol, player);
            if (!wouldBeSafe) {
                flankScore -= 25; // Moderate penalty (flanking is inherently risky)
            } else {
                flankScore += 10; // Small bonus for safety
            }
            
            if (flankScore > bestFlankScore) {
                bestFlankScore = flankScore;
                bestFlankMove = [newRow, newCol];
            }
        }
        
        // BEHAVIORAL REQUIREMENT: Diamonds should always move for flanking, even with low scores
        // Reduced threshold to ensure diamonds are always active in flanking maneuvers
        if (bestFlankMove && bestFlankScore > 10) {
            console.log(`[AI DEBUG] Diamond ${card.value}${card.suit} MANDATORY flanking maneuver to [${bestFlankMove[0]},${bestFlankMove[1]}] (score: ${bestFlankScore}) - diamonds always flank enemy leader from behind`);
            return {
                type: 'diamond_formation_break',
                card: card,
                fromRow: row,
                fromCol: col,
                toRow: bestFlankMove[0],
                toCol: bestFlankMove[1]
            };
        }
    }
    
    // BEHAVIORAL REQUIREMENT: If no flanking move found, ensure diamonds still move toward enemy territory
    // Diamonds should never be idle - always reposition for flanking opportunities
    for (const { card, row, col } of playerCards) {
        const validMoves = getValidMoves(card, row, col);
        if (validMoves.length === 0) continue;
        
        let bestRepositionMove = null;
        let bestRepositionScore = -1;
        
        for (const [newRow, newCol] of validMoves) {
            let repositionScore = 0;
            
            // Priority: Move toward enemy territory for future flanking
            const enemyTerritoryBonus = (enemyPlayer === 1) ? 
                (10 - newRow) * 10 : // Move toward top for enemy player 1
                newRow * 10;         // Move toward bottom for enemy player 2
            repositionScore += enemyTerritoryBonus;
            
            // Bonus for moving to sides (flanking positions)
            const centerCol = 5;
            const sideDistance = Math.abs(newCol - centerCol);
            repositionScore += sideDistance * 5; // Favor side positions
            
            // Safety consideration
            const wouldBeSafe = !willCardBeThreatenedAtPosition(card, newRow, newCol, player);
            if (wouldBeSafe) {
                repositionScore += 15;
            } else {
                repositionScore -= 10; // Small penalty for unsafe moves
            }
            
            if (repositionScore > bestRepositionScore) {
                bestRepositionScore = repositionScore;
                bestRepositionMove = [newRow, newCol];
            }
        }
        
        if (bestRepositionMove && bestRepositionScore > 0) {
            console.log(`[AI DEBUG] Diamond ${card.value}${card.suit} MANDATORY repositioning for flanking to [${bestRepositionMove[0]},${bestRepositionMove[1]}] (score: ${bestRepositionScore}) - diamonds always stay active`);
            return {
                type: 'diamond_reposition',
                card: card,
                fromRow: row,
                fromCol: col,
                toRow: bestRepositionMove[0],
                toCol: bestRepositionMove[1]
            };
        }
    }
    
    return null;
}

// PROTECTIVE POSITIONING FUNCTIONS

// Calculate threat vectors to determine where protection is needed
function calculateLeaderThreatVectors(player) {
    const leaderPos = findLeaderPosition(player);
    if (!leaderPos) return [];
    
    const [leaderRow, leaderCol] = leaderPos;
    const enemyPlayer = player === 1 ? 2 : 1;
    const threatVectors = [];
    
    // Find all enemy cards that could threaten the leader
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const enemyCard = gameState.board[r][c];
            if (enemyCard && enemyCard.owner === enemyPlayer && !isCardExhausted(enemyCard)) {
                const distance = Math.abs(r - leaderRow) + Math.abs(c - leaderCol);
                
                // Consider threats within 5 hexes (potential attack range)
                if (distance <= 5 && enemyCard.attack > 0) {
                    const directionVector = {
                        rowDir: r < leaderRow ? -1 : (r > leaderRow ? 1 : 0),
                        colDir: c < leaderCol ? -1 : (c > leaderCol ? 1 : 0)
                    };
                    
                    threatVectors.push({
                        enemyCard,
                        enemyRow: r,
                        enemyCol: c,
                        distance,
                        direction: directionVector,
                        threatLevel: enemyCard.attack,
                        canCurrentlyAttack: distance <= 2 // Can attack in next turn
                    });
                }
            }
        }
    }
    
    return threatVectors.sort((a, b) => a.distance - b.distance); // Sort by distance (closest first)
}

// Find positions that would block threats to the leader
function findProtectivePositions(player, threatVectors) {
    const leaderPos = findLeaderPosition(player);
    if (!leaderPos) return [];
    
    const [leaderRow, leaderCol] = leaderPos;
    const protectivePositions = [];
    
    for (const threat of threatVectors) {
        // Calculate positions between the threat and the leader
        const positions = [];
        
        // For each step from threat towards leader, find blocking positions
        let currentRow = threat.enemyRow;
        let currentCol = threat.enemyCol;
        
        while (Math.abs(currentRow - leaderRow) > 1 || Math.abs(currentCol - leaderCol) > 1) {
            // Move one step towards leader
            if (currentRow < leaderRow) currentRow++;
            else if (currentRow > leaderRow) currentRow--;
            
            if (currentCol < leaderCol) currentCol++;
            else if (currentCol > leaderCol) currentCol--;
            
            // Check if this position is valid and would block the threat
            if (currentRow >= 0 && currentRow < 11 && currentCol >= 0 && currentCol < 11) {
                const existingCard = gameState.board[currentRow][currentCol];
                
                // Position is good if empty or has our weak card that could be replaced
                if (!existingCard || (existingCard.owner === player && existingCard.suit !== 'joker')) {
                    const distanceToLeader = Math.abs(currentRow - leaderRow) + Math.abs(currentCol - leaderCol);
                    
                    positions.push({
                        row: currentRow,
                        col: currentCol,
                        blocksEnemyAt: [threat.enemyRow, threat.enemyCol],
                        threatLevel: threat.threatLevel,
                        distanceToLeader,
                        isEmptyPosition: !existingCard,
                        priority: threat.canCurrentlyAttack ? 100 : (50 - threat.distance * 5) // Higher priority for immediate threats
                    });
                }
            }
        }
        
        protectivePositions.push(...positions);
    }
    
    // Remove duplicates and sort by priority
    const uniquePositions = protectivePositions.filter((pos, index, arr) => 
        arr.findIndex(p => p.row === pos.row && p.col === pos.col) === index
    );
    
    return uniquePositions.sort((a, b) => b.priority - a.priority);
}

// Find best protective summoning position
function findProtectiveSummonPosition(player) {
    const threatVectors = calculateLeaderThreatVectors(player);
    if (threatVectors.length === 0) return null;
    
    const protectivePositions = findProtectivePositions(player, threatVectors);
    const leaderPos = findLeaderPosition(player);
    const hand = gameState.players[player].hand;
    
    if (!leaderPos || protectivePositions.length === 0 || hand.length === 0) return null;
    
    const [leaderRow, leaderCol] = leaderPos;
    const leaderNeighbors = getHexNeighbors(leaderRow, leaderCol);
    
    // Find protective positions that are adjacent to leader (summoning requirement)
    const validSummonPositions = protectivePositions.filter(pos => 
        leaderNeighbors.some(([r, c]) => r === pos.row && c === pos.col)
    );
    
    if (validSummonPositions.length === 0) return null;
    
    // Choose the highest priority card for protection (high attack or defense)
    const bestCard = hand.reduce((best, current) => {
        const bestScore = (best.attack * 2) + best.defense + getCardValuePriority(best);
        const currentScore = (current.attack * 2) + current.defense + getCardValuePriority(current);
        return currentScore > bestScore ? current : best;
    });
    
    // Among protective positions, prefer those in front of leader
    const bestPosition = validSummonPositions.reduce((best, current) => {
        let bestScore = best.priority;
        let currentScore = current.priority;
        
        // Add front-line bonus to protective scoring
        const bestFrontBonus = isInFrontOfLeader(player, leaderPos, best.row, best.col) ? 30 : -10;
        const currentFrontBonus = isInFrontOfLeader(player, leaderPos, current.row, current.col) ? 30 : -10;
        
        bestScore += bestFrontBonus;
        currentScore += currentFrontBonus;
        
        return currentScore > bestScore ? current : best;
    });
    
    console.log(`[AI DEBUG] Protective summoning: ${bestCard.value}${bestCard.suit} at [${bestPosition.row},${bestPosition.col}] blocks threat from [${bestPosition.blocksEnemyAt[0]},${bestPosition.blocksEnemyAt[1]}]`);
    
    return {
        card: bestCard,
        row: bestPosition.row,
        col: bestPosition.col,
        protectionType: 'threat_blocking',
        threatLevel: bestPosition.threatLevel
    };
}

// Find best protective movement (move existing cards to protect leader)
function findProtectiveMovement(player) {
    const threatVectors = calculateLeaderThreatVectors(player);
    if (threatVectors.length === 0) return null;
    
    const protectivePositions = findProtectivePositions(player, threatVectors);
    if (protectivePositions.length === 0) return null;
    
    // Find our cards that can move to protective positions
    const playerCards = [];
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && card.suit !== 'joker' && !isCardExhausted(card)) {
                playerCards.push({ card, row: r, col: c });
            }
        }
    }
    
    for (const { card, row, col } of playerCards) {
        const validMoves = getValidMoves(card, row, col);
        
        for (const protectivePos of protectivePositions) {
            // Check if this card can move to this protective position
            if (validMoves.some(([r, c]) => r === protectivePos.row && c === protectivePos.col)) {
                const wouldBeSafe = !willCardBeThreatenedAtPosition(card, protectivePos.row, protectivePos.col, player);
                
                // Only move if the position is reasonably safe or the threat is immediate
                if (wouldBeSafe || protectivePos.priority >= 100) {
                    console.log(`[AI DEBUG] Protective movement: ${card.value}${card.suit} from [${row},${col}] to [${protectivePos.row},${protectivePos.col}] blocks threat from [${protectivePos.blocksEnemyAt[0]},${protectivePos.blocksEnemyAt[1]}]`);
                    
                    return {
                        type: 'protective_blocking',
                        card: card,
                        fromRow: row,
                        fromCol: col,
                        toRow: protectivePos.row,
                        toCol: protectivePos.col,
                        threatLevel: protectivePos.threatLevel
                    };
                }
            }
        }
    }
    
    return null;
}

// Helper function to determine if a position is "in front" of the leader (towards enemy)
function isInFrontOfLeader(player, leaderPos, targetRow, targetCol) {
    if (!leaderPos) return false;
    
    const [leaderRow, leaderCol] = leaderPos;
    
    // For Player 1: "front" means higher row numbers (towards Player 2)
    // For Player 2: "front" means lower row numbers (towards Player 1)
    if (player === 1) {
        return targetRow > leaderRow;
    } else {
        return targetRow < leaderRow;
    }
}

// Calculate front-line positioning bonus based on how well positioned the card is
function calculateFrontLineBonus(player, leaderPos, targetRow, targetCol) {
    if (!leaderPos) return 0;
    
    const [leaderRow, leaderCol] = leaderPos;
    const distanceFromLeader = Math.abs(targetRow - leaderRow) + Math.abs(targetCol - leaderCol);
    
    // Base bonus for being in front of leader
    let bonus = 0;
    if (isInFrontOfLeader(player, leaderPos, targetRow, targetCol)) {
        bonus += 60; // Strong bonus for front positioning
        
        // Additional bonus for optimal front-line distance (2-3 hexes from leader)
        if (distanceFromLeader >= 2 && distanceFromLeader <= 3) {
            bonus += 40; // Optimal front-line distance
        } else if (distanceFromLeader === 1) {
            bonus += 20; // Adjacent protection is still good
        } else if (distanceFromLeader >= 4 && distanceFromLeader <= 5) {
            bonus += 10; // Extended front-line still helpful
        }
    } else {
        // Penalty for being behind the leader
        bonus -= 30;
    }
    
    return bonus;
}

// Card data - only A through 10
const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

// Helper function to get card value priority (higher values = higher priority)
function getCardValuePriority(card) {
    if (card.suit === 'joker') {
        return 15; // Leaders get highest priority
    }
    
    const valueIndex = values.indexOf(card.value);
    if (valueIndex === -1) return 0; // Unknown value
    
    // Ace = 1, 2 = 2, ..., 10 = 10 (higher numbers = higher priority)
    if (card.value === 'A') return 1;
    return parseInt(card.value);
}

// Helper function to get player-based color for card numbers/values
function getPlayerColor(card) {
    if (card.owner === 1) {
        return '#87ceeb'; // Light sky blue for Player 1 - matches gold's lightness
    } else if (card.owner === 2) {
        return '#ffd700'; // Gold for Player 2
    }
    return '#ffffff'; // Default white
}

// Helper function to get suit-specific color for suit symbols
function getSuitColor(suit, card = null) {
    switch (suit) {
        case 'hearts':
            return '#dc3545'; // Red
        case 'diamonds':
            return '#fd7e14'; // Orange
        case 'clubs':
            return '#198754'; // Green
        case 'spades':
            return '#9966ff'; // Lighter purple
        case 'joker':
            // Leaders use the same color as their player's numbers
            return card ? getPlayerColor(card) : '#ffd700'; // Fallback to gold if no card provided
        default:
            return '#ffffff'; // Default white
    }
}

// Suit symbols for display
const suitSymbols = {
    'hearts': '♥',
    'diamonds': '♦',
    'clubs': '♣',
    'spades': '♠'
};

// Hex grid utilities
function getHexNeighbors(row, col) {
    const neighbors = [];
    const directions = [
        [1, 1],   // more-right
        [1, -1],  // more-left
        [-1, 0],  // up
        [0, 1],   // right
        [1, 0],   // down
        [0, -1]   // left
    ];

    if (col % 2 === 0) {
        directions[0][0] = -1;
        directions[1][0] = -1;
    }
    
    for (const [dr, dc] of directions) {
        const newRow = row + dr;
        const newCol = col + dc;
        if (newRow >= 0 && newRow < 11 && newCol >= 0 && newCol < 11 && isValidHex(newRow, newCol)) {
            neighbors.push([newRow, newCol]);
        }
    }
    return neighbors;
}

function getDistance(row1, col1, row2, col2) {
    // Check if positions are adjacent in hexagonal grid
    const neighbors = getHexNeighbors(row1, col1);
    if (neighbors.some(([r, c]) => r === row2 && c === col2)) {
        return 1; // Adjacent positions
    }
    
    // For non-adjacent positions, use a simple approximation
    // This is mainly used for determining if it's a ranged attack
    const rowDiff = Math.abs(row2 - row1);
    const colDiff = Math.abs(col2 - col1);
    return Math.max(rowDiff, colDiff);
}

function isInPlayerTerritory(row, col, player) {
    return player === 1 ? row >= 5 : row < 5; // Changed for 11-row map
}

function getActualPlayerTerritory(row, col, player) {
    // For setup and placement, always use the original territory logic
    // regardless of map rotation (visual only)
    return isInPlayerTerritory(row, col, player);
}

// Card creation and deck management
function createDeck() {
    const deck = [];
    for (const suit of suits) {
        for (const value of values) {
            deck.push({
                suit,
                value,
                attack: getCardAttack(value),
                defense: getCardDefense(value, suit),
                id: `${suit}_${value}_${Math.random()}`,
                faceDown: false,
                owner: null
            });
        }
    }
    
    // Add Joker (Leader)
    deck.push({
        suit: 'joker',
        value: 'JOKER',
        attack: 0, // Leaders have no attack
        defense: 0, // Leaders have no defense
        id: `joker_${Math.random()}`,
        faceDown: false,
        owner: null
    });
    
    return shuffleDeck(deck);
}

function getCardAttack(value) {
    if (value === 'A') return 1;
    return parseInt(value) || 0;
}

function getCardDefense(value, suit) {
    const baseDefense = getCardAttack(value);
    if (suit === 'spades') return baseDefense * 2;
    if (suit === 'clubs') return baseDefense + 5;
    return baseDefense;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// Hexagonal coordinate system
function getHexCorners(x, y) {
    const corners = [];
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        corners.push({
            x: x + hexSize * Math.cos(angle),
            y: y + hexSize * Math.sin(angle)
        });
    }
    return corners;
}

function hexToPixel(col, row) {
    const x = hexSize * 1.5 * col + boardOffsetX;
    const y = hexSize * Math.sqrt(3) * (row + 0.5 * (col % 2)) + boardOffsetY;
    
    // If map is flipped, flip the visual position around the canvas center
    if (mapRotated) {
        const logicalWidth = canvas.logicalWidth || canvas.width;
        const logicalHeight = canvas.logicalHeight || canvas.height;
        return { 
            x: logicalWidth - x, 
            y: logicalHeight - y 
        };
    }
    
    return { x, y };
}

function pixelToHex(pixelX, pixelY) {
    let actualPixelX = pixelX;
    let actualPixelY = pixelY;
    
    // If map is flipped, transform pixel coordinates back to normal space
    if (mapRotated) {
        const logicalWidth = canvas.logicalWidth || canvas.width;
        const logicalHeight = canvas.logicalHeight || canvas.height;
        actualPixelX = logicalWidth - pixelX;
        actualPixelY = logicalHeight - pixelY;
    }
    
    // Convert to hex coordinates using proper offset hexagonal grid math
    const q = (actualPixelX - boardOffsetX) / (hexSize * 1.5);
    const col = Math.round(q);
    
    // Calculate row using the correct column offset (even columns are shifted down by 0.5)
    const r = (actualPixelY - boardOffsetY) / (hexSize * Math.sqrt(3)) - 0.5 * (col % 2);
    const row = Math.round(r);
    
    if (col >= 0 && col < 11 && row >= 0 && row < 11 && isValidHex(row, col)) {
        return { col, row };
    }
    return null;
}

// FALLBACK ACTION FUNCTIONS: Ensure AI never ends turn without acting

function findFallbackSummonAction(player) {
    console.log(`[AI DEBUG] Finding fallback summon action for player ${player}`);
    
    const leaderPos = findLeaderPosition(player);
    if (!leaderPos || gameState.players[player].hand.length === 0) {
        return null;
    }

    // Check if we must summon due to card count requirement
    const mapCounts = countCardsOnMap(player);
    const mustSummonDueToCardCount = mapCounts.regularCards < 5;
    
    // BEHAVIORAL REQUIREMENT: Always allow fallback summoning if less than 5 regular cards
    if (gameState.leaderAttackedThisTurn && !mustSummonDueToCardCount) {
        console.log(`[AI DEBUG] Leader attacked this turn, but not forcing due to card count (${mapCounts.regularCards} >= 5)`);
        return null;
    }
    
    if (mustSummonDueToCardCount) {
        console.log(`[AI DEBUG] FALLBACK SUMMON REQUIRED: Only ${mapCounts.regularCards} regular cards (< 5) - forcing fallback summoning`);
    }

    // Get ANY valid adjacent position to leader
    const leaderNeighbors = getHexNeighbors(leaderPos[0], leaderPos[1]);
    const anyValidPosition = leaderNeighbors.find(([row, col]) => {
        if (row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE) {
            const existingCard = gameState.board[row][col];
            // Can place on empty spots or replace own cards
            return !existingCard || existingCard.owner === player;
        }
        return false;
    });

    if (anyValidPosition && gameState.players[player].hand.length > 0) {
        // Pick the highest value card for fallback summoning
        const handCards = gameState.players[player].hand;
        const highestValueCard = handCards.reduce((best, current) => {
            const bestPriority = getCardValuePriority(best);
            const currentPriority = getCardValuePriority(current);
            return currentPriority > bestPriority ? current : best;
        });
        
        console.log(`[AI DEBUG] Fallback summon: highest value card ${highestValueCard.value}${highestValueCard.suit} (priority: ${getCardValuePriority(highestValueCard)}) to [${anyValidPosition[0]},${anyValidPosition[1]}]`);
        
        return {
            card: highestValueCard,
            row: anyValidPosition[0],
            col: anyValidPosition[1]
        };
    }

    return null;
}

function findFallbackReplaceAction(player) {
    console.log(`[AI DEBUG] Finding fallback replace action for player ${player}`);
    
    if (gameState.leaderAttackedThisTurn || gameState.players[player].hand.length === 0) {
        return null;
    }

    // Find ANY of our cards on the board that could be replaced with ANY hand card
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const existingCard = gameState.board[r][c];
            if (existingCard && existingCard.owner === player) {
                // Try to replace with the highest value card from hand that's an upgrade
                let bestHandCard = null;
                let bestScore = -1;
                
                for (const handCard of gameState.players[player].hand) {
                    // Even a sidegrade is better than doing nothing
                    const existingValue = existingCard.attack + existingCard.defense;
                    const handValue = handCard.attack + handCard.defense;
                    
                    if (handValue >= existingValue) { // >= allows even trades to avoid doing nothing
                        // Score based on stat improvement + card value priority
                        const statImprovement = handValue - existingValue;
                        const valuePriority = getCardValuePriority(handCard);
                        const score = statImprovement + valuePriority * 2; // Prioritize higher value cards
                        
                        if (score > bestScore) {
                            bestScore = score;
                            bestHandCard = handCard;
                        }
                    }
                }
                
                if (bestHandCard) {
                    const existingValue = existingCard.attack + existingCard.defense;
                    const handValue = bestHandCard.attack + bestHandCard.defense;
                    console.log(`[AI DEBUG] Fallback replace: ${existingCard.value}${existingCard.suit} (${existingValue}) with ${bestHandCard.value}${bestHandCard.suit} (${handValue}, priority: ${getCardValuePriority(bestHandCard)}) at [${r},${c}]`);
                    
                    return {
                        row: r,
                        col: c,
                        oldCard: existingCard,
                        newCard: bestHandCard
                    };
                }
            }
        }
    }

    return null;
}

function findFallbackRepositionAction(player) {
    console.log(`[AI DEBUG] Finding fallback reposition action for player ${player}`);
    
    // Find any card that can move anywhere
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && !isCardExhausted(card)) {
                const validMoves = getValidMoves(card, r, c);
                
                if (validMoves.length > 0) {
                    // Just pick the first valid move - any movement is better than nothing
                    const firstMove = validMoves[0];
                    console.log(`[AI DEBUG] Fallback reposition: ${card.value}${card.suit} from [${r},${c}] to [${firstMove[0]},${firstMove[1]}]`);
                    
                    return {
                        card: card,
                        fromRow: r,
                        fromCol: c,
                        toRow: firstMove[0],
                        toCol: firstMove[1]
                    };
                }
            }
        }
    }

    return null;
}

function findAnyLegalAction(player) {
    console.log(`[AI DEBUG] Finding ANY legal action for player ${player}`);
    
    // Find any card that can do anything at all
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player && !isCardExhausted(card)) {
                // Try moving
                const validMoves = getValidMoves(card, r, c);
                if (validMoves.length > 0) {
                    return {
                        type: 'move',
                        fromRow: r,
                        fromCol: c,
                        toRow: validMoves[0][0],
                        toCol: validMoves[0][1]
                    };
                }
                
                // Try attacking
                const validAttacks = getValidAttacks(card, r, c);
                if (validAttacks.length > 0) {
                    return {
                        type: 'attack',
                        fromRow: r,
                        fromCol: c,
                        toRow: validAttacks[0][0],
                        toCol: validAttacks[0][1]
                    };
                }
            }
        }
    }

    return null;
}

function isValidHex(row, col) {
    // Remove even-indexed cells from the top row for vertical symmetry
    if (row === 0 && col % 2 === 0) {
        return false; // Even columns in row 0 are invalid
    }
    return true;
}

function drawHexagon(x, y, fillColor, strokeColor = '#666', lineWidth = 2) {
    const corners = getHexCorners(x, y);
    
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) {
        ctx.lineTo(corners[i].x, corners[i].y);
    }
    ctx.closePath();
    
    if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fill();
    }
    
    if (strokeColor) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
    }
}

// Flash Caption System
function showFlashCaption(text, type = 'default', duration = 2000) {
    const flashCaption = document.getElementById('flash-caption');
    const flashText = document.getElementById('flash-text');
    
    // Clear any existing classes
    flashText.className = '';
    
    // Add the appropriate class for styling
    if (type !== 'default') {
        flashText.classList.add(type);
    }
    
    // Set the text
    flashText.textContent = text;
    
    // Show the caption
    flashCaption.classList.remove('hidden');
    flashCaption.classList.add('visible');
    
    // Hide after duration
    setTimeout(() => {
        flashCaption.classList.remove('visible');
        flashCaption.classList.add('hidden');
    }, duration);
}

function showSetupCaption() {
    showFlashCaption('SETUP PHASE', 'setup', 1000);
}

function showBattleCaption() {
    showFlashCaption('BATTLE BEGINS!', 'battle', 1000);
}

function showPlayerTurnCaption(player) {
    const playerName = `PLAYER ${player}`;
    const type = player === 1 ? 'player1' : 'player2';
    showFlashCaption(playerName, type, 1000);
}

function showPlayerWinCaption(player) {
    const winText = `PLAYER ${player} WINS!`;
    showFlashCaption(winText, 'win', 10000);
}

// HTML5/CSS fade-out animation functions
function startFadeOutAnimation(card, position, animationType = 'captured') {
    // Get the canvas position for this card
    const pos = hexToPixel(position[1], position[0]);
    const canvas = document.getElementById('hex-canvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    // Create a DOM element overlay that looks exactly like a hand card
    const overlay = document.createElement('div');
    overlay.className = `card card-fade-overlay ${animationType}`;
    
    // Position overlay exactly over the canvas card - make it larger
    overlay.style.position = 'absolute';
    overlay.style.left = (canvasRect.left + pos.x - 24) + 'px'; // Center on card (24px = half larger card width)
    overlay.style.top = (canvasRect.top + pos.y - 32) + 'px'; // Center on card (32px = half larger card height)
    overlay.style.width = '48px';  // 1.5x larger than hand cards
    overlay.style.height = '64px'; // 1.5x larger than hand cards
    overlay.style.zIndex = '1001';
    overlay.style.pointerEvents = 'none';
    
    // Set card colors - use player color for background
    const playerColor = getPlayerColor(card);
    const suitColor = card.faceDown ? '#888' : getSuitColor(card.suit, card);
    
    overlay.style.border = `2px solid ${playerColor}`;
    overlay.style.backgroundColor = card.faceDown ? '#333' : playerColor;
    
    // Add special styling for leaders (jokers)
    if (card.suit === 'joker') {
        overlay.classList.add('joker', `player${card.owner}`);
    }
    
    // Create card content structure like hand cards
    if (!card.faceDown) {
        const valueDiv = document.createElement('div');
        valueDiv.className = 'card-value';
        valueDiv.style.fontSize = '20px'; // Larger font for bigger card
        valueDiv.style.color = suitColor; // Use suit color for text
        valueDiv.textContent = card.suit === 'joker' ? '★' : card.value;
        overlay.appendChild(valueDiv);
        
        const suitDiv = document.createElement('div');
        suitDiv.className = 'card-suit';
        suitDiv.style.fontSize = '22px'; // Larger font for bigger card
        suitDiv.style.color = suitColor; // Use suit color for text
        suitDiv.textContent = getSuitSymbol(card.suit);
        overlay.appendChild(suitDiv);
    }
    
    // Add to DOM
    document.body.appendChild(overlay);
    fadeOutElements.push(overlay);
    
    // Trigger fade-out animation
    requestAnimationFrame(() => {
        overlay.classList.add('fade-out');
    });
    
    // Remove card from board immediately and clean up overlay after animation
    gameState.board[position[0]][position[1]] = null;
    
    const duration = animationType === 'captured' ? 600 : 800;
    setTimeout(() => {
        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
        fadeOutElements = fadeOutElements.filter(el => el !== overlay);
        updateCanvas(); // Refresh canvas after animation
    }, duration);
}

// Leader attack animation - shows damage effect without removing the leader
function startLeaderAttackAnimation(leader, position) {
    // Get the canvas position for the leader
    const pos = hexToPixel(position[1], position[0]);
    const canvas = document.getElementById('hex-canvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    // Create a damage effect overlay
    const overlay = document.createElement('div');
    overlay.className = 'card card-fade-overlay leader-attacked';
    
    // Position overlay exactly over the leader - make it much larger and more dramatic
    overlay.style.position = 'absolute';
    overlay.style.left = (canvasRect.left + pos.x - 32) + 'px'; // Much larger overlay
    overlay.style.top = (canvasRect.top + pos.y - 42) + 'px';
    overlay.style.width = '64px';  // 2x larger than hand cards
    overlay.style.height = '84px'; // 2x larger than hand cards
    overlay.style.zIndex = '1002';
    overlay.style.pointerEvents = 'none';
    
    // Make it look like the leader with dramatic damage effect
    overlay.style.border = `4px solid #ff0000`;
    overlay.style.backgroundColor = 'rgba(255, 0, 0, 0.9)';
    overlay.style.boxShadow = '0 0 40px rgba(255, 0, 0, 1), 0 0 80px rgba(255, 100, 100, 0.5)';
    overlay.style.borderRadius = '8px';
    
    overlay.classList.add('joker', `player${leader.owner}`);
    
    // Add leader star with dramatic effects
    const valueDiv = document.createElement('div');
    valueDiv.className = 'card-value';
    valueDiv.textContent = '★';
    valueDiv.style.color = '#fff';
    valueDiv.style.fontSize = '28px';
    valueDiv.style.textShadow = '0 0 20px #ff0000, 0 0 40px #ff0000';
    valueDiv.style.animation = 'flash-red 0.15s ease-in-out infinite';
    overlay.appendChild(valueDiv);
    
    // Add dramatic "DAMAGE" effect
    const attackedDiv = document.createElement('div');
    attackedDiv.className = 'card-suit';
    attackedDiv.textContent = '💥';
    attackedDiv.style.color = '#fff';
    attackedDiv.style.fontSize = '20px';
    attackedDiv.style.textShadow = '0 0 15px #ff0000';
    overlay.appendChild(attackedDiv);
    
    // Add to DOM
    document.body.appendChild(overlay);
    fadeOutElements.push(overlay);
    
    // Trigger damage effect animation
    requestAnimationFrame(() => {
        overlay.classList.add('fade-out');
    });
    
    // Clean up after animation (leader stays on board)
    setTimeout(() => {
        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
        fadeOutElements = fadeOutElements.filter(el => el !== overlay);
    }, 1000);
}

// Replacement summon animation - shows old card transforming to new card
function startReplacementAnimation(oldCard, newCard, position) {
    // Get the canvas position for this card
    const pos = hexToPixel(position[1], position[0]);
    const canvas = document.getElementById('hex-canvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    // Create old card overlay
    const oldOverlay = document.createElement('div');
    oldOverlay.className = 'card card-fade-overlay replacement-old';
    
    // Position old card overlay
    oldOverlay.style.position = 'absolute';
    oldOverlay.style.left = (canvasRect.left + pos.x - 24) + 'px';
    oldOverlay.style.top = (canvasRect.top + pos.y - 32) + 'px';
    oldOverlay.style.width = '48px';
    oldOverlay.style.height = '64px';
    oldOverlay.style.zIndex = '1003';
    oldOverlay.style.pointerEvents = 'none';
    
    // Style old card
    const oldPlayerColor = getPlayerColor(oldCard);
    const oldSuitColor = getSuitColor(oldCard.suit, oldCard);
    oldOverlay.style.border = `2px solid ${oldPlayerColor}`;
    oldOverlay.style.backgroundColor = oldPlayerColor;
    
    // Add old card content
    if (!oldCard.faceDown) {
        const oldValueDiv = document.createElement('div');
        oldValueDiv.className = 'card-value';
        oldValueDiv.style.fontSize = '20px';
        oldValueDiv.style.color = oldSuitColor;
        oldValueDiv.textContent = oldCard.suit === 'joker' ? '★' : oldCard.value;
        oldOverlay.appendChild(oldValueDiv);
        
        const oldSuitDiv = document.createElement('div');
        oldSuitDiv.className = 'card-suit';
        oldSuitDiv.style.fontSize = '22px';
        oldSuitDiv.style.color = oldSuitColor;
        oldSuitDiv.textContent = getSuitSymbol(oldCard.suit);
        oldOverlay.appendChild(oldSuitDiv);
    }
    
    // Create new card overlay (starts hidden)
    const newOverlay = document.createElement('div');
    newOverlay.className = 'card card-fade-overlay replacement-new';
    
    // Position new card overlay (same position)
    newOverlay.style.position = 'absolute';
    newOverlay.style.left = (canvasRect.left + pos.x - 24) + 'px';
    newOverlay.style.top = (canvasRect.top + pos.y - 32) + 'px';
    newOverlay.style.width = '48px';
    newOverlay.style.height = '64px';
    newOverlay.style.zIndex = '1004';
    newOverlay.style.pointerEvents = 'none';
    newOverlay.style.opacity = '0';
    newOverlay.style.transform = 'scale(0.5)';
    
    // Style new card
    const newPlayerColor = getPlayerColor(newCard);
    const newSuitColor = getSuitColor(newCard.suit, newCard);
    newOverlay.style.border = `2px solid ${newPlayerColor}`;
    newOverlay.style.backgroundColor = newPlayerColor;
    
    // Add new card content
    if (!newCard.faceDown) {
        const newValueDiv = document.createElement('div');
        newValueDiv.className = 'card-value';
        newValueDiv.style.fontSize = '20px';
        newValueDiv.style.color = newSuitColor;
        newValueDiv.textContent = newCard.suit === 'joker' ? '★' : newCard.value;
        newOverlay.appendChild(newValueDiv);
        
        const newSuitDiv = document.createElement('div');
        newSuitDiv.className = 'card-suit';
        newSuitDiv.style.fontSize = '22px';
        newSuitDiv.style.color = newSuitColor;
        newSuitDiv.textContent = getSuitSymbol(newCard.suit);
        newOverlay.appendChild(newSuitDiv);
    }
    
    // Add to DOM
    document.body.appendChild(oldOverlay);
    document.body.appendChild(newOverlay);
    fadeOutElements.push(oldOverlay, newOverlay);
    
    // Start animation sequence
    requestAnimationFrame(() => {
        // Old card fades out and shrinks
        oldOverlay.classList.add('fade-out');
        
        // After a longer delay, new card appears and grows (show old card longer)
        setTimeout(() => {
            newOverlay.classList.add('fade-in');
        }, 800);
    });
    
    // Clean up after animation (extended to accommodate longer old card display)
    setTimeout(() => {
        [oldOverlay, newOverlay].forEach(overlay => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        });
        fadeOutElements = fadeOutElements.filter(el => el !== oldOverlay && el !== newOverlay);
        updateCanvas(); // Refresh canvas after animation
    }, 1800);
}

// Attack animation - shows attacker cards briefly
function startAttackAnimation(attackers, targetPosition) {
    if (!attackers || attackers.length === 0) return;
    
    const canvas = document.getElementById('hex-canvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    // Get target position for animation direction
    const targetPos = hexToPixel(targetPosition[1], targetPosition[0]);
    
    attackers.forEach((attacker, index) => {
        const attackerCard = attacker.card || attacker; // Handle both {card, position} and direct card objects
        const attackerPos = attacker.position || findCardPosition(attackerCard);
        
        if (!attackerPos) return;
        
        const pos = hexToPixel(attackerPos[1], attackerPos[0]);
        
        // Create attacker overlay
        const overlay = document.createElement('div');
        overlay.className = 'card card-fade-overlay attacker-highlight';
        
        // Position overlay over attacker
        overlay.style.position = 'absolute';
        overlay.style.left = (canvasRect.left + pos.x - 28) + 'px'; // Slightly larger for attack highlight
        overlay.style.top = (canvasRect.top + pos.y - 36) + 'px';
        overlay.style.width = '56px';  // Larger for emphasis
        overlay.style.height = '72px';
        overlay.style.zIndex = '1005';
        overlay.style.pointerEvents = 'none';
        
        // Style attacker card with attack effects
        const playerColor = getPlayerColor(attackerCard);
        const suitColor = getSuitColor(attackerCard.suit, attackerCard);
        overlay.style.border = `3px solid #ffd700`; // Gold border for attacking
        overlay.style.backgroundColor = playerColor;
        overlay.style.boxShadow = '0 0 20px rgba(255, 215, 0, 0.8), 0 0 40px rgba(255, 215, 0, 0.4)';
        
        // Add special styling for leaders
        if (attackerCard.suit === 'joker') {
            overlay.classList.add('joker', `player${attackerCard.owner}`);
        }
        
        // Add card content
        if (!attackerCard.faceDown) {
            const valueDiv = document.createElement('div');
            valueDiv.className = 'card-value';
            valueDiv.style.fontSize = '22px';
            valueDiv.style.color = suitColor;
            valueDiv.style.textShadow = '0 0 10px #ffd700';
            valueDiv.textContent = attackerCard.suit === 'joker' ? '★' : attackerCard.value;
            overlay.appendChild(valueDiv);
            
            const suitDiv = document.createElement('div');
            suitDiv.className = 'card-suit';
            suitDiv.style.fontSize = '24px';
            suitDiv.style.color = suitColor;
            suitDiv.style.textShadow = '0 0 10px #ffd700';
            suitDiv.textContent = getSuitSymbol(attackerCard.suit);
            overlay.appendChild(suitDiv);
        }
        
        // Add attack indicator
        const attackDiv = document.createElement('div');
        attackDiv.style.position = 'absolute';
        attackDiv.style.top = '-10px';
        attackDiv.style.right = '-10px';
        attackDiv.style.fontSize = '16px';
        attackDiv.style.color = '#ff4444';
        attackDiv.style.textShadow = '0 0 5px #ff4444';
        attackDiv.textContent = '⚔️';
        overlay.appendChild(attackDiv);
        
        // Add to DOM
        document.body.appendChild(overlay);
        fadeOutElements.push(overlay);
        
        // Stagger the animation start for multiple attackers
        setTimeout(() => {
            requestAnimationFrame(() => {
                overlay.classList.add('attacking');
            });
        }, index * 100);
        
        // Clean up after animation
        setTimeout(() => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            fadeOutElements = fadeOutElements.filter(el => el !== overlay);
        }, 1500 + (index * 100));
    });
}

// Game initialization
function initGame(preserveAISettings = false) {
    // Initialize canvas
    canvas = document.getElementById('hex-canvas');
    ctx = canvas.getContext('2d');
    
    // Set up canvas to fill viewport
    resizeCanvas();
    
    hexWidth = hexSize * 2;
    hexHeight = hexSize * Math.sqrt(3);
    
    // Add event listeners
    canvas.addEventListener('click', handleCanvasClick);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleMapZoom);
    
    // Add touch event support for mobile
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    
    window.addEventListener('resize', resizeCanvas);
    
    // Set up menu close functionality
    document.addEventListener('click', handleMenuClose);
    document.addEventListener('touchend', handleMenuClose);
    
    // Set up hand container reference
    const handContainer = document.getElementById('player-hand');
    
    // Only reset AI settings on page load, not during "New Game"
    if (!preserveAISettings) {
        aiEnabled = { 1: false, 2: true };
        console.log('Page loaded: Defaulting to P1 human vs P2 AI');
    } else {
        console.log('New Game: Preserving current AI settings:', aiEnabled);
    }
    
    // Try to load saved game state
    const savedState = loadGameState();
    if (savedState) {
        gameState = savedState;
        // Ensure selectedCards is properly initialized
        if (!gameState.selectedCards) {
            gameState.selectedCards = [];
        }
        // Ensure proper data structures are initialized
        if (!(gameState.cardsMovedThisTurn instanceof Set)) {
            gameState.cardsMovedThisTurn = new Set(gameState.cardsMovedThisTurn || []);
        }
        if (!(gameState.cardsAttackedThisTurn instanceof Set)) {
            gameState.cardsAttackedThisTurn = new Set(gameState.cardsAttackedThisTurn || []);
        }
        if (!(gameState.cardsAttackExhaustion instanceof Map)) {
            gameState.cardsAttackExhaustion = new Map(Object.entries(gameState.cardsAttackExhaustion || {}));
        }
        console.log('Loaded saved game state (AI settings remain as default)');
    } else {
        // Create new game
        console.log('No saved state found, creating new game with default AI settings');
        // Create decks for both players (40 cards each: A-10 of 4 suits)
        const deck1 = createDeck();
        const deck2 = createDeck();
        
        // Set card owners for all cards (including leaders)
        deck1.forEach(card => card.owner = 1);
        deck2.forEach(card => card.owner = 2);
        
        // Separate leaders from decks and put them directly in hands
        gameState.players[1].leader = deck1.find(card => card.suit === 'joker');
        gameState.players[2].leader = deck2.find(card => card.suit === 'joker');
        
        // Remove leaders from decks and put them in hands immediately
        gameState.players[1].deck = deck1.filter(card => card.suit !== 'joker');
        gameState.players[2].deck = deck2.filter(card => card.suit !== 'joker');
        
        // Put leaders directly in hands
        gameState.players[1].hand.push(gameState.players[1].leader);
        gameState.players[2].hand.push(gameState.players[2].leader);
        
        // Draw 10 additional cards to complete starting hands (1 leader + 10 regular = 11 total)
        drawCards(1, 10);
        drawCards(2, 10);
    }
    
    // Initialize board (for both new and loaded games)
    updateCanvas();
    updateUI();
    
    // Initialize draggable overlays for board cards
    updateBoardCardOverlays();
    
    // Initialize cursor
    updateCursor(null, null);
    
    // Initialize map flipping based on AI presence
    updateMapFlippingForAI();
    
    // Update all AI buttons to show correct state
    updateAllAIButtons();
    
    // Initialize AI aggression levels
    initializeAIAggression();
    
    // Show setup caption when game starts (only for new games, not loaded games)
    if (gameState.phase === 'setup' && gameState.turn === 1) {
        showSetupCaption();
        
        // Auto-select leader for the starting player if they haven't placed their leader yet
        const leaderOnBoard = findLeaderPosition(gameState.currentPlayer);
        if (!leaderOnBoard) {
            autoSelectLeaderForSetup(gameState.currentPlayer);
        }
    }
    
    // Trigger AI move if current player is AI controlled
    if (aiEnabled[gameState.currentPlayer]) {
        setTimeout(() => {
            if (gameState.phase === 'setup') {
                performAISetupMove(gameState.currentPlayer);
            } else if (gameState.phase === 'play') {
                performAIMove(gameState.currentPlayer);
            }
        }, 2000); // Longer delay on game start
    }
}

// Helper function to get canvas coordinates from mouse/touch events
function getCanvasCoordinates(event) {
    const rect = canvas.getBoundingClientRect();
    // Use logical dimensions for proper scaling
    const logicalWidth = canvas.logicalWidth || canvas.width;
    const logicalHeight = canvas.logicalHeight || canvas.height;
    
    return {
        x: (event.clientX - rect.left) * (logicalWidth / rect.width),
        y: (event.clientY - rect.top) * (logicalHeight / rect.height)
    };
}

function resizeCanvas() {
    // Mobile optimization: use device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    // Set actual size in memory (with device pixel ratio)
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    
    // Scale the canvas back down using CSS
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    
    // Scale the drawing context to match device pixel ratio
    ctx.scale(dpr, dpr);
    
    // Use logical pixels for calculations
    canvas.logicalWidth = width;
    canvas.logicalHeight = height;
    
    // Reset any previous transformations before applying new scale
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    
    // Update hex dimensions based on current zoom
    hexWidth = hexSize * 2;
    hexHeight = hexSize * Math.sqrt(3);
    
    // Calculate board centering using logical dimensions
    const mapWidth = 11 * hexSize * 1.5 + hexSize * 0.5;
    const mapHeight = 11 * hexSize * Math.sqrt(3);
    
    boardOffsetX = (width - mapWidth) / 2;
    boardOffsetY = (height - mapHeight) / 2;
    
    // Ensure minimum margins (mobile-friendly)
    const isMobile = window.innerWidth <= 768;
    boardOffsetX = Math.max(boardOffsetX, isMobile ? 20 : 50);
    boardOffsetY = Math.max(boardOffsetY, isMobile ? 80 : 100); // More space for UI
    
    if (gameState.phase) {
        updateCanvas();
    }
}

function handleMouseMove(event) {
    const coords = getCanvasCoordinates(event);
    
    // Track mouse position for drag visuals
    lastMousePos = { x: event.clientX, y: event.clientY };
    
    // Handle unified drag system
    if (dragState.isDragging) {
        handleDragMove(event, coords);
        return; // Don't process other mouse move logic during drag
    }
    
    // Handle map dragging first
    handleMapDrag(event);
    
    // Then handle hex hovering for coordinate display
    let scaledX = coords.x;
    let scaledY = coords.y;
    
    const hex = pixelToHex(scaledX, scaledY);
    const prevHovered = hoveredHex;
    
    if (hex && hex.row >= 0 && hex.row < 11 && hex.col >= 0 && hex.col < 11 && isValidHex(hex.row, hex.col)) {
        hoveredHex = [hex.row, hex.col];
        // Use page coordinates for absolute positioning
        updateCoordinateDisplay(hex.col, hex.row, event.clientX, event.clientY);
        
        // Check if hovering over a valid attack target and calculate preview results
        const prevAttackTarget = hoveredAttackTarget;
        if (gameState.phase === 'play' && gameState.validAttacks && 
            gameState.validAttacks.some(([r, c]) => r === hex.row && c === hex.col)) {
            hoveredAttackTarget = [hex.row, hex.col];
            attackPreviewResults = calculateAttackResults(hex.row, hex.col);
        } else {
            hoveredAttackTarget = null;
            attackPreviewResults = null;
        }
        
        // Update cursor based on context
        updateCursor(hex.row, hex.col);
        
        // Redraw if hover changed or attack target changed
        const hoverChanged = !prevHovered !== !hoveredHex || 
                            (prevHovered && hoveredHex && (prevHovered[0] !== hoveredHex[0] || prevHovered[1] !== hoveredHex[1]));
        const attackTargetChanged = !prevAttackTarget !== !hoveredAttackTarget || 
                                   (prevAttackTarget && hoveredAttackTarget && (prevAttackTarget[0] !== hoveredAttackTarget[0] || prevAttackTarget[1] !== hoveredAttackTarget[1]));
        
        if (hoverChanged || attackTargetChanged) {
            updateCanvas();
        }
    } else {
        hoveredHex = null;
        hoveredAttackTarget = null;
        attackPreviewResults = null;
        updateCoordinateDisplay(null, null);
        
        // Reset cursor when not over valid hex
        updateCursor(null, null);
        
        // Redraw if hover changed
        const hoverChanged = !prevHovered !== !hoveredHex || 
                            (prevHovered && hoveredHex && (prevHovered[0] !== hoveredHex[0] || prevHovered[1] !== hoveredHex[1]));
        
        if (hoverChanged) {
            updateCanvas();
        }
    }
}

function handleMouseDown(event) {
    // Check if any desktop drag is already in progress
    if (handDesktopDragState.isDragging || desktopDragState.isDragging) {
        return; // Let the specific drag handlers manage the event
    }
    
    // Only handle map dragging now - board card dragging uses custom mouse handlers
    handleMapDragStart(event);
}

function handleMouseUp(event) {
    // Check if any desktop drag is in progress
    if (handDesktopDragState.isDragging || desktopDragState.isDragging) {
        return; // Let the specific drag handlers manage the event
    }
    
    if (dragState.isDragging) {
        handleDragEnd(event);
    } else {
        // Handle map drag end
        handleMapDragEnd(event);
    }
}

// Unified drag start function
function startCardDrag(card, hex, x, y, dragType) {
    dragState.isDragging = true;
    dragState.dragType = dragType;
    dragState.draggedCard = card;
    dragState.startX = x;
    dragState.startY = y;
    dragState.startHex = hex;
    dragState.currentHex = hex;
    
    // Legacy compatibility
    isDraggingCard = true;
    draggedCard = card;
    
    // Check if this card is part of a multi-selection
    const isMultiSelected = gameState.selectedCards && gameState.selectedCards.some(selected => selected.card === card);
    
    if (isMultiSelected) {
        // This is a combined attack drag - keep multi-selection
        dragState.dragType = 'card-attack';
        console.log(`Started combined attack drag with ${gameState.selectedCards.length} cards`);
    } else if (dragType === 'card-move') {
        // Clear any existing selections for single card drag
        clearSelection();
        selectCard(card, hex.row, hex.col);
        console.log(`Started single card drag with ${card.value}${card.suit}`);
    }
}

// Unified drag move handler
function handleDragMove(event, coords) {
    const hex = pixelToHex(coords.x, coords.y);
    
    if (hex && hex.row >= 0 && hex.row < 11 && hex.col >= 0 && hex.col < 11 && isValidHex(hex.row, hex.col)) {
        const prevHex = dragState.currentHex;
        dragState.currentHex = hex;
        
        // Update hover state
        hoveredHex = [hex.row, hex.col];
        
        if (dragState.dragType === 'card-move') {
            // Check if we're hovering over an enemy card for attack preview
            const targetCard = gameState.board[hex.row][hex.col];
            if (targetCard && targetCard.owner !== dragState.draggedCard.owner) {
                // Show attack preview - only calculate if hex actually changed
                if (gameState.validAttacks && gameState.validAttacks.some(([r, c]) => r === hex.row && c === hex.col)) {
                    const prevTarget = hoveredAttackTarget;
                    hoveredAttackTarget = [hex.row, hex.col];
                    // Only recalculate if target changed
                    if (!prevTarget || prevTarget[0] !== hex.row || prevTarget[1] !== hex.col) {
                        attackPreviewResults = calculateAttackResults(hex.row, hex.col);
                    }
                }
            } else {
                hoveredAttackTarget = null;
                attackPreviewResults = null;
            }
        }
        
        // Update coordinate display only if hex changed
        if (!prevHex || prevHex.row !== hex.row || prevHex.col !== hex.col) {
            updateCoordinateDisplay(hex.col, hex.row, event.clientX, event.clientY);
        }
        
        // Redraw if hex changed - use throttled rendering for better performance
        if (!prevHex || prevHex.row !== hex.row || prevHex.col !== hex.col) {
            requestDragUpdate();
        }
    }
}

// Unified drag end handler
function handleDragEnd(event) {
    if (!dragState.isDragging) return;
    
    const coords = getCanvasCoordinates(event);
    const hex = pixelToHex(coords.x, coords.y);
    
    console.log(`Ending ${dragState.dragType} drag`);
    
    if (hex && hex.row >= 0 && hex.row < 11 && hex.col >= 0 && hex.col < 11 && isValidHex(hex.row, hex.col)) {
        if (dragState.dragType === 'card-move') {
            handleCardDragEnd(hex);
        } else if (dragState.dragType === 'hand-summon') {
            handleHandSummonDragEnd(hex);
        }
    }
    
    // Reset drag state
    resetDragState();
}

function handleCardDragEnd(targetHex) {
    const card = dragState.draggedCard;
    const startHex = dragState.startHex;
    
    // Check if this is a combined attack (multi-selection)
    const isMultiSelected = gameState.selectedCards && gameState.selectedCards.some(selected => selected.card === card);
    
    if (isMultiSelected) {
        // This is a combined attack
        const targetCard = gameState.board[targetHex.row][targetHex.col];
        if (targetCard && targetCard.owner !== card.owner) {
            // Perform combined attack if it's a valid target
            if (gameState.validAttacks && gameState.validAttacks.some(([r, c]) => r === targetHex.row && c === targetHex.col)) {
                performCombinedAttack(targetHex.row, targetHex.col);
                return;
            }
        }
        console.log('Invalid combined attack target');
        return;
    }
    
    // Single card actions
    // Check if we're attacking an enemy card
    const targetCard = gameState.board[targetHex.row][targetHex.col];
    if (targetCard && targetCard.owner !== card.owner) {
        // Perform attack if it's a valid target
        if (gameState.validAttacks && gameState.validAttacks.some(([r, c]) => r === targetHex.row && c === targetHex.col)) {
            performAttack(targetHex.row, targetHex.col);
            return;
        }
    }
    
    // Check if we're moving to a valid move position
    if (gameState.validMoves && gameState.validMoves.some(([r, c]) => r === targetHex.row && c === targetHex.col)) {
        moveCard(startHex.row, startHex.col, targetHex.row, targetHex.col, card);
        return;
    }
    
    // If drag ends on the same position, it's just a selection (equivalent to click)
    if (startHex.row === targetHex.row && startHex.col === targetHex.col) {
        // Select the card and show its valid moves/attacks (like clicking)
        selectCard(card, startHex.row, startHex.col);
        return;
    }
    
    // Invalid drop - do nothing
    console.log('Invalid drag target');
}

function resetDragState() {
    dragState.isDragging = false;
    dragState.dragType = null;
    dragState.draggedCard = null;
    dragState.startHex = null;
    dragState.currentHex = null;
    
    // Legacy compatibility
    isDraggingCard = false;
    draggedCard = null;
    
    // Clear attack preview
    hoveredAttackTarget = null;
    attackPreviewResults = null;
    
    updateCanvas();
}

// Create invisible draggable overlays for board cards
function updateBoardCardOverlays() {
    // Remove existing overlays
    const existingOverlays = document.querySelectorAll('.board-card-overlay');
    existingOverlays.forEach(overlay => overlay.remove());
    
    // Create new overlays for each draggable card
    for (let row = 0; row < 11; row++) {
        for (let col = 0; col < 11; col++) {
            if (!isValidHex(row, col)) continue;
            
            const card = gameState.board[row][col];
            if (card && card.owner === gameState.currentPlayer && !isCardExhausted(card)) {
                createBoardCardOverlay(card, row, col);
            }
        }
    }
}

function createBoardCardOverlay(card, row, col) {
    const pos = hexToPixel(col, row);
    const canvas = document.getElementById('hex-canvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    // Create invisible draggable element
    const overlay = document.createElement('div');
    overlay.className = 'board-card-overlay';
    overlay.dataset.cardId = card.id;
    overlay.dataset.row = row;
    overlay.dataset.col = col;
    
    // Position over the card - make touch targets larger on mobile
    const hexRadius = hexSize * (isTouchDevice ? 1.0 : 0.8); // Larger touch targets on mobile
    overlay.style.position = 'absolute';
    overlay.style.left = `${canvasRect.left + pos.x - hexRadius}px`;
    overlay.style.top = `${canvasRect.top + pos.y - hexRadius}px`;
    overlay.style.width = `${hexRadius * 2}px`;
    overlay.style.height = `${hexRadius * 2}px`;
    overlay.style.backgroundColor = 'transparent';
    overlay.style.cursor = isTouchDevice ? 'default' : 'grab';
    overlay.style.zIndex = '1000';
    overlay.style.pointerEvents = 'auto';
    
    // Show grab cursor on hover for desktop
    if (!isTouchDevice) {
        overlay.addEventListener('mouseenter', () => {
            overlay.style.cursor = 'grab';
        });
        overlay.addEventListener('mouseleave', () => {
            overlay.style.cursor = 'grab';
        });
    }
    
    if (isTouchDevice) {
        // Mobile touch-based drag
        overlay.addEventListener('touchstart', (e) => handleBoardCardTouchStart(e, card, row, col), { passive: false });
        overlay.addEventListener('touchmove', handleBoardCardTouchMove, { passive: false });
        overlay.addEventListener('touchend', handleBoardCardTouchEnd, { passive: false });
        

    } else {
        // Desktop mouse-based drag (same logic as mobile)
        overlay.addEventListener('mousedown', (e) => handleBoardCardMouseStart(e, card, row, col));
        overlay.addEventListener('mousemove', handleBoardCardMouseMove);
        overlay.addEventListener('mouseup', handleBoardCardMouseEnd);
        // Prevent default drag behavior
        overlay.draggable = false;
        

    }
    
    document.body.appendChild(overlay);
}

// Desktop mouse handlers for board card dragging (mirrors mobile touch logic)
let desktopDragState = {
    isDragging: false,
    draggedCard: null,
    startRow: null,
    startCol: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0
};

function handleBoardCardMouseStart(e, card, row, col) {
    e.preventDefault();
    e.stopPropagation();
    
    // Set up desktop drag state
    desktopDragState.isDragging = true;
    desktopDragState.draggedCard = card;
    desktopDragState.startRow = row;
    desktopDragState.startCol = col;
    desktopDragState.startX = e.clientX;
    desktopDragState.startY = e.clientY;
    desktopDragState.currentX = e.clientX;
    desktopDragState.currentY = e.clientY;
    
    // Set up unified drag state for visual feedback
    dragState.isDragging = true;
    dragState.dragType = 'card-move';
    dragState.draggedCard = card;
    dragState.startHex = { row, col };
    dragState.startX = e.clientX;
    dragState.startY = e.clientY;
    
    // Update mouse position for visual feedback
    lastMousePos = { x: e.clientX, y: e.clientY };
    
    // Clear any existing selections when starting drag
    selectedCards = [];
    
    // Show valid moves and attacks for the dragged card
    showValidMovesAndAttacks(card, row, col);
    
    // Change cursor to grabbing during drag
    document.body.style.cursor = 'grabbing';
    
    // Add global mouse event listeners for drag continuation
    document.addEventListener('mousemove', handleBoardCardMouseMove);
    document.addEventListener('mouseup', handleBoardCardMouseEnd);
    
    // Update canvas to show dragging visuals
    requestDragUpdate();
}

function handleBoardCardMouseMove(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (!desktopDragState.isDragging) return;
    
    desktopDragState.currentX = e.clientX;
    desktopDragState.currentY = e.clientY;
    
    // Update mouse position for visual feedback
    lastMousePos = { x: e.clientX, y: e.clientY };
    
    // Update hover preview during drag
    updateDragHoverPreview(e.clientX, e.clientY, desktopDragState.draggedCard, desktopDragState.startRow, desktopDragState.startCol);
    
    // Update canvas for smooth visual feedback
    requestDragUpdate();
}

function handleBoardCardMouseEnd(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (!desktopDragState.isDragging) return;
    
    // Remove global event listeners
    document.removeEventListener('mousemove', handleBoardCardMouseMove);
    document.removeEventListener('mouseup', handleBoardCardMouseEnd);
    
    // Restore cursor
    document.body.style.cursor = '';
    
    // Calculate drag distance to determine if this was a drag or click
    const dragDistance = Math.sqrt(
        Math.pow(desktopDragState.currentX - desktopDragState.startX, 2) +
        Math.pow(desktopDragState.currentY - desktopDragState.startY, 2)
    );
    
    if (dragDistance < 10) {
        // Short drag distance - treat as click for selection
        console.log('Short drag detected, selecting card:', desktopDragState.draggedCard.value + desktopDragState.draggedCard.suit);
        // Clear original selection so it won't be restored
        dragState.originalSelection = null;
        handleMobileCardSelection(desktopDragState.draggedCard, desktopDragState.startRow, desktopDragState.startCol, e.ctrlKey);
    } else {
        // Long drag distance - process as drag-and-drop
        const coords = getCanvasCoordinates({ clientX: desktopDragState.currentX, clientY: desktopDragState.currentY });
        const targetHex = pixelToHex(coords.x, coords.y);
        
        let actionProcessed = false;
        if (targetHex && isValidHex(targetHex.row, targetHex.col)) {
            // Check if drag ended at initial position
            const endedAtInitialPosition = targetHex.row === desktopDragState.startRow && targetHex.col === desktopDragState.startCol;
            
            if (endedAtInitialPosition) {
                // Drag stopped at initial grid - select the card for action and multi-selection
                // Clear original selection so it won't be restored
                dragState.originalSelection = null;
                handleMobileCardSelection(desktopDragState.draggedCard, desktopDragState.startRow, desktopDragState.startCol, e.ctrlKey);
            } else {
                // Process the drag action
                actionProcessed = processBoardCardDrag(desktopDragState.draggedCard, desktopDragState.startRow, desktopDragState.startCol, targetHex.row, targetHex.col);
                
                // After drag action, automatically select the card if it has remaining actions
                if (actionProcessed) {
                    autoSelectCardAfterDragAction(desktopDragState.draggedCard, targetHex.row, targetHex.col);
                }
            }
        }
        
        // If no action was processed and didn't end at initial position, still select the card
        if (!actionProcessed && targetHex && isValidHex(targetHex.row, targetHex.col) && 
            !(targetHex.row === desktopDragState.startRow && targetHex.col === desktopDragState.startCol)) {
            // Clear original selection so it won't be restored
            dragState.originalSelection = null;
            handleMobileCardSelection(desktopDragState.draggedCard, desktopDragState.startRow, desktopDragState.startCol, e.ctrlKey);
        }
    }
    
    // Clean up drag state
    desktopDragState.isDragging = false;
    desktopDragState.draggedCard = null;
    dragState.isDragging = false;
    dragState.dragType = null;
    dragState.draggedCard = null;
    
    // Clear highlights and previews only if no card is selected after drag
    // (if a card got selected during drag end, we want to keep its highlights)
    if (!gameState.selectedCard && (!gameState.selectedCards || gameState.selectedCards.length === 0)) {
        clearDragHighlights();
    } else {
        // Clear only drag-specific state but keep selection highlights
        hoveredHex = null;
        hoveredAttackTarget = null;
        attackPreviewResults = null;
        // Reset original selection since we're keeping current selection
        dragState.originalSelection = null;
    }
    
    // Update canvas to remove dragging visuals
    updateCanvas();
}

// Mobile touch handlers for board card dragging
let mobileDragState = {
    isDragging: false,
    draggedCard: null,
    startRow: null,
    startCol: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0
};

function handleBoardCardTouchStart(e, card, row, col) {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    
    // Haptic feedback on supported devices
    if (navigator.vibrate) {
        navigator.vibrate(50); // Short vibration
    }
    
    // Set up mobile drag state
    mobileDragState.isDragging = true;
    mobileDragState.draggedCard = card;
    mobileDragState.startRow = row;
    mobileDragState.startCol = col;
    mobileDragState.startX = touch.clientX;
    mobileDragState.startY = touch.clientY;
    mobileDragState.currentX = touch.clientX;
    mobileDragState.currentY = touch.clientY;
    
    // Set up unified drag state for visual feedback
    dragState.isDragging = true;
    dragState.dragType = 'card-move';
    dragState.draggedCard = card;
    dragState.startHex = { row, col };
    dragState.startX = touch.clientX;
    dragState.startY = touch.clientY;
    
    // Update mouse position for visual feedback
    lastMousePos = { x: touch.clientX, y: touch.clientY };
    
    // Clear any existing selections when starting drag
    selectedCards = [];
    
    // Show valid moves and attacks for the dragged card
    showValidMovesAndAttacks(mobileDragState.draggedCard, mobileDragState.startRow, mobileDragState.startCol);
    
    // Update canvas to show dragging visuals
    requestDragUpdate();
}

function handleBoardCardTouchMove(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (!mobileDragState.isDragging || e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    mobileDragState.currentX = touch.clientX;
    mobileDragState.currentY = touch.clientY;
    
    // Update mouse position for visual feedback
    lastMousePos = { x: touch.clientX, y: touch.clientY };
    
    // Update hover preview during drag
    updateDragHoverPreview(touch.clientX, touch.clientY, mobileDragState.draggedCard, mobileDragState.startRow, mobileDragState.startCol);
    
    // Update canvas for smooth visual feedback
    requestDragUpdate();
}

function handleBoardCardTouchEnd(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (!mobileDragState.isDragging) return;
    
    // Calculate drag distance to determine if this was a drag or tap
    const dragDistance = Math.sqrt(
        Math.pow(mobileDragState.currentX - mobileDragState.startX, 2) +
        Math.pow(mobileDragState.currentY - mobileDragState.startY, 2)
    );
    
    if (dragDistance < 10) {
        // Short drag distance - treat as tap for selection
        console.log('Short touch detected, selecting card:', mobileDragState.draggedCard.value + mobileDragState.draggedCard.suit);
        // Clear original selection so it won't be restored
        dragState.originalSelection = null;
        handleMobileCardSelection(mobileDragState.draggedCard, mobileDragState.startRow, mobileDragState.startCol, false);
    } else {
        // Long drag distance - process as drag-and-drop
        const coords = getCanvasCoordinates({ clientX: mobileDragState.currentX, clientY: mobileDragState.currentY });
        const targetHex = pixelToHex(coords.x, coords.y);
        
        let actionProcessed = false;
        if (targetHex && isValidHex(targetHex.row, targetHex.col)) {
            // Check if drag ended at initial position
            const endedAtInitialPosition = targetHex.row === mobileDragState.startRow && targetHex.col === mobileDragState.startCol;
            
            if (endedAtInitialPosition) {
                // Drag stopped at initial grid - select the card for action and multi-selection
                // Clear original selection so it won't be restored
                dragState.originalSelection = null;
                handleMobileCardSelection(mobileDragState.draggedCard, mobileDragState.startRow, mobileDragState.startCol, false);
            } else {
                // Process the drag action
                actionProcessed = processBoardCardDrag(mobileDragState.draggedCard, mobileDragState.startRow, mobileDragState.startCol, targetHex.row, targetHex.col);
                
                // After drag action, automatically select the card if it has remaining actions
                if (actionProcessed) {
                    autoSelectCardAfterDragAction(mobileDragState.draggedCard, targetHex.row, targetHex.col);
                }
            }
        }
        
        // If no action was processed and didn't end at initial position, still select the card  
        if (!actionProcessed && targetHex && isValidHex(targetHex.row, targetHex.col) && 
            !(targetHex.row === mobileDragState.startRow && targetHex.col === mobileDragState.startCol)) {
            // Clear original selection so it won't be restored
            dragState.originalSelection = null;
            handleMobileCardSelection(mobileDragState.draggedCard, mobileDragState.startRow, mobileDragState.startCol, false);
        }
    }
    
    // Clean up drag state
    mobileDragState.isDragging = false;
    mobileDragState.draggedCard = null;
    dragState.isDragging = false;
    dragState.dragType = null;
    dragState.draggedCard = null;
    
    // Clear highlights and previews only if no card is selected after drag
    // (if a card got selected during drag end, we want to keep its highlights)
    if (!gameState.selectedCard && (!gameState.selectedCards || gameState.selectedCards.length === 0)) {
        clearDragHighlights();
    } else {
        // Clear only drag-specific state but keep selection highlights
        hoveredHex = null;
        hoveredAttackTarget = null;
        attackPreviewResults = null;
        // Reset original selection since we're keeping current selection
        dragState.originalSelection = null;
    }
    
    // Update canvas to remove dragging visuals
    updateCanvas();
}

function handleBoardCardSelection(card, row, col) {
    // Handle card selection (for multi-select or single selection)
    const cardIndex = selectedCards.findIndex(selected => 
        selected.card.id === card.id && selected.row === row && selected.col === col
    );
    
    if (cardIndex >= 0) {
        // Card is already selected, deselect it
        selectedCards.splice(cardIndex, 1);
    } else {
        // Add card to selection
        selectedCards.push({ card, row, col });
    }
    
    updateCanvas();
}

function processBoardCardDrag(card, startRow, startCol, targetRow, targetCol) {
    // Check if this is a valid move or attack
    const startHex = { row: startRow, col: startCol };
    const targetHex = { row: targetRow, col: targetCol };
    
    // Check for movement
    if (!gameState.board[targetRow][targetCol]) {
        // Empty hex - try to move
        if (canMoveCard(card, startHex, targetHex)) {
            // Save state before moving
            saveStateToHistory();
            moveCard(startRow, startCol, targetRow, targetCol);
            
            // Clear drag highlights and handle post-move selection
            clearDragHighlights();
            
            // Check if card can still attack after moving
            const newValidAttacks = getValidAttacks(card, targetRow, targetCol);
            if (newValidAttacks.length > 0) {
                // Keep card selected for attacks
                gameState.selectedCard = card;
                gameState.selectedHex = [targetRow, targetCol];
                gameState.validMoves = []; // Can't move again
                gameState.validAttacks = newValidAttacks;
                gameState.blockedMoves = getBlockedMoves(card, targetRow, targetCol);
                gameState.absorptions = getAbsorptions(card, targetRow, targetCol);
            } else {
                // Card is done, clear everything
                clearSelection();
            }
            
            // Update canvas to refresh visual indicators
            updateCanvas();
            return true; // Action processed successfully
        }
    } else {
        // Occupied hex - try to attack
        const targetCard = gameState.board[targetRow][targetCol];
        if (targetCard.owner !== gameState.currentPlayer && canAttackCard(card, startHex, targetCard, targetHex)) {
            // Save state before attacking
            saveStateToHistory();
            // Perform attack
            attack(startRow, startCol, targetRow, targetCol);
            
            // Clear drag highlights and selection after attack
            clearDragHighlights();
            clearSelection();
            
            // Update canvas to refresh visual indicators  
            updateCanvas();
            return true; // Action processed successfully
        }
    }
    
    // Invalid action - show feedback
    showInvalidActionFeedback();
    return false; // No action processed
}

function showInvalidActionFeedback() {
    // Visual feedback for invalid actions
    // Could add a brief red flash or other indication
    console.log("Invalid action");
}

function autoSelectCardAfterDragAction(draggedCard, finalRow, finalCol) {
    // Check if the card still has actions available after the drag
    // This should happen after the card has moved to its final position
    
    // For movement actions, the card should be at the final position
    // For attack actions, the card should still be at its original position
    const cardPosition = findCardPosition(draggedCard);
    if (!cardPosition) {
        // Card was destroyed in battle or moved off board
        return;
    }
    
    const [currentRow, currentCol] = cardPosition;
    
    // Check if card is exhausted or has no remaining actions
    if (isCardExhausted(draggedCard)) {
        return;
    }
    
    // Check for remaining actions
    const hasMovement = !gameState.cardsMovedThisTurn.has(draggedCard.id) && getValidMoves(draggedCard, currentRow, currentCol).length > 0;
    const hasAttacks = !gameState.cardsAttackedThisTurn.has(draggedCard.id) && getValidAttacks(draggedCard, currentRow, currentCol).length > 0;
    
    // Auto-select the card if it has remaining actions
    if (hasMovement || hasAttacks) {
        // Add a small delay so user can see the action completed before new selection
        setTimeout(() => {
            // Clear any existing selection first
            clearSelection();
            
            // Select the card for additional actions
            selectCard(draggedCard, currentRow, currentCol);
            console.log(`Auto-selected ${draggedCard.value}${draggedCard.suit} for additional actions`);
        }, 200); // 200ms delay for better UX
    }
}

function showValidMovesAndAttacks(card, row, col) {
    // Clear previous highlights
    gameState.validMoves = [];
    gameState.validAttacks = [];
    gameState.blockedMoves = [];
    gameState.absorptions = [];
    hoveredHex = null;
    hoveredAttackTarget = null;
    attackPreviewResults = null;
    
    // Temporarily set selection state for visual consistency during drag
    // Store original selection to restore later
    if (!dragState.originalSelection) {
        dragState.originalSelection = {
            selectedCard: gameState.selectedCard,
            selectedHex: gameState.selectedHex,
            selectedCards: [...(gameState.selectedCards || [])]
        };
    }
    
    // Set drag selection state BEFORE calculating moves/attacks (mimics card selection for visual purposes)
    // This ensures face down cards are treated as selected and behave like face up cards
    gameState.selectedCard = card;
    gameState.selectedHex = [row, col];
    
    // Get all the same information as card selection (now with card properly marked as selected)
    gameState.validMoves = getValidMoves(card, row, col);
    gameState.validAttacks = getValidAttacks(card, row, col);
    gameState.blockedMoves = getBlockedMoves(card, row, col);
    gameState.absorptions = getAbsorptions(card, row, col);
    
    // Update canvas to show highlights
    updateCanvas();
}

function showValidSummonPositions(card) {
    // Clear previous highlights
    gameState.validMoves = [];
    gameState.validAttacks = [];
    gameState.blockedMoves = [];
    gameState.absorptions = [];
    hoveredHex = null;
    hoveredAttackTarget = null;
    attackPreviewResults = null;
    
    if (gameState.phase === 'setup') {
        // In setup phase, show all valid hexes
        gameState.validMoves = [];
        for (let r = 0; r < 11; r++) {
            for (let c = 0; c < 11; c++) {
                if (isValidHex(r, c) && canSummonCard(card, r, c)) {
                    gameState.validMoves.push([r, c]);
                }
            }
        }
    } else {
        // In play phase, use the same logic as handleHandCardSelection
        const leaderPos = findLeaderPosition(gameState.currentPlayer);
        if (leaderPos && !gameState.leaderAttackedThisTurn) {
            const mapCounts = countCardsOnMap(gameState.currentPlayer);
            const isAtMaxCapacity = mapCounts.leaderCount >= 1 && mapCounts.regularCards >= 5;
            const neighbors = getHexNeighbors(leaderPos[0], leaderPos[1]);
            
            if (isAtMaxCapacity) {
                // At max capacity - only show positions with existing cards to replace
                gameState.validMoves = neighbors.filter(([r, c]) => {
                    const existingCard = gameState.board[r][c];
                    return existingCard && existingCard.owner === gameState.currentPlayer;
                });
                // All valid moves will result in discarding the existing card
                validDiscards = [...gameState.validMoves];
            } else {
                // Not at max - show all valid summoning positions (empty or own cards)
                gameState.validMoves = neighbors.filter(([r, c]) => {
                    const existingCard = gameState.board[r][c];
                    return !existingCard || existingCard.owner === gameState.currentPlayer;
                });
                // Only positions with existing friendly cards will be discarded
                validDiscards = neighbors.filter(([r, c]) => {
                    const existingCard = gameState.board[r][c];
                    return existingCard && existingCard.owner === gameState.currentPlayer;
                });
            }
        }
    }
    
    // Update canvas to show highlights
    updateCanvas();
}

function updateDragHoverPreview(clientX, clientY, card, startRow, startCol) {
    // Get the hex under the cursor
    const coords = getCanvasCoordinates({ clientX, clientY });
    const targetHex = pixelToHex(coords.x, coords.y);
    
    if (!targetHex || !isValidHex(targetHex.row, targetHex.col)) {
        // Clear hover preview if not over valid hex
        hoveredHex = null;
        hoveredAttackTarget = null;
        attackPreviewResults = null;
        return;
    }
    
    hoveredHex = [targetHex.row, targetHex.col];
    const targetCard = gameState.board[targetHex.row][targetHex.col];
    
    if (!targetCard) {
        // Empty hex - check if it's a valid move
        if (gameState.validMoves && gameState.validMoves.some(([r, c]) => r === targetHex.row && c === targetHex.col)) {
            // Valid move target
            hoveredAttackTarget = null;
            attackPreviewResults = null;
        } else {
            // Invalid move target
            hoveredHex = null;
        }
    } else if (targetCard.owner !== card.owner) {
        // Enemy card - check if it's a valid attack
        if (gameState.validAttacks && gameState.validAttacks.some(([r, c]) => r === targetHex.row && c === targetHex.col)) {
            // Valid attack target - show preview
            hoveredAttackTarget = [targetHex.row, targetHex.col];
            attackPreviewResults = calculateAttackPreview([{card, row: startRow, col: startCol}], targetHex.row, targetHex.col);
        } else {
            // Invalid attack target
            hoveredHex = null;
            hoveredAttackTarget = null;
            attackPreviewResults = null;
        }
    } else {
        // Own card - not a valid target
        hoveredHex = null;
        hoveredAttackTarget = null;
        attackPreviewResults = null;
    }
}

function updateHandDragHoverPreview(clientX, clientY, card) {
    // Get the hex under the cursor
    const coords = getCanvasCoordinates({ clientX, clientY });
    const targetHex = pixelToHex(coords.x, coords.y);
    
    if (!targetHex || !isValidHex(targetHex.row, targetHex.col)) {
        // Clear hover preview if not over valid hex
        hoveredHex = null;
        return;
    }
    
    // Check if this is a valid summoning position
    if (gameState.validMoves && gameState.validMoves.some(([r, c]) => r === targetHex.row && c === targetHex.col)) {
        hoveredHex = [targetHex.row, targetHex.col];
    } else {
        hoveredHex = null;
    }
}

function clearDragHighlights() {
    // Restore original selection state if it was stored
    if (dragState.originalSelection) {
        gameState.selectedCard = dragState.originalSelection.selectedCard;
        gameState.selectedHex = dragState.originalSelection.selectedHex;
        gameState.selectedCards = dragState.originalSelection.selectedCards;
        dragState.originalSelection = null;
    }
    
    // Clear all drag-related highlights and previews
    gameState.validMoves = [];
    gameState.validAttacks = [];
    gameState.blockedMoves = [];
    gameState.absorptions = [];
    hoveredHex = null;
    hoveredAttackTarget = null;
    attackPreviewResults = null;
}

function calculateAttackPreview(selectedCards, targetRow, targetCol) {
    const target = gameState.board[targetRow][targetCol];
    if (!target) return null;
    
    // Don't show attack results when target is face down
    if (target.faceDown && target.owner !== gameState.currentPlayer) {
        return null;
    }
    
    let attackers = selectedCards.map(selected => selected.card);
    let totalAttack = attackers.reduce((sum, card) => sum + card.attack, 0);
    
    // Check for spade absorption
    const firstAttacker = selectedCards[0];
    const absorber = findSpadeAbsorber(
        firstAttacker.row, firstAttacker.col, 
        targetRow, targetCol, target.owner
    );
    const actualDefender = absorber || target;
    
    const results = {
        targetCaptured: false,
        attackersCasualites: [],
        survivingAttackers: [],
        actualDefender: actualDefender,
        totalAttack: totalAttack,
        isLeaderAttack: false,
        captureTokensAdded: 0
    };
    
    // Handle different target types
    if (actualDefender.suit === 'joker') {
        // Attacking a Leader
        results.isLeaderAttack = true;
        results.captureTokensAdded = 3;
        results.targetCaptured = false; // Leader stays on board
        results.survivingAttackers = [...attackers]; // All attackers survive (no counter-attack from Leader)
    } else if (totalAttack >= actualDefender.defense) {
        // Regular unit is defeated
        results.targetCaptured = true;
        results.captureTokensAdded = 1;
        
        // Check which attackers survive counter-attack
        const counterAttack = actualDefender.attack;
        attackers.forEach(attacker => {
            if (attacker.defense <= counterAttack) {
                results.attackersCasualites.push(attacker);
            } else {
                results.survivingAttackers.push(attacker);
            }
        });
    } else {
        // Target survives, check for attacker casualties from counter-attack
        results.targetCaptured = false;
        results.captureTokensAdded = 0;
        
        const counterAttack = actualDefender.attack;
        attackers.forEach(attacker => {
            if (attacker.defense <= counterAttack) {
                results.attackersCasualites.push(attacker);
            } else {
                results.survivingAttackers.push(attacker);
            }
        });
    }
    
    return results;
}

// Desktop mouse handlers for hand card dragging (mirrors mobile touch logic)
let handDesktopDragState = {
    isDragging: false,
    draggedCard: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    cardElement: null
};

function handleHandCardMouseStart(e, card) {
    e.preventDefault();
    e.stopPropagation();
    
    // Set up desktop drag state
    handDesktopDragState.isDragging = true;
    handDesktopDragState.draggedCard = card;
    handDesktopDragState.startX = e.clientX;
    handDesktopDragState.startY = e.clientY;
    handDesktopDragState.currentX = e.clientX;
    handDesktopDragState.currentY = e.clientY;
    handDesktopDragState.cardElement = e.target;
    
    // Set up unified drag state for visual feedback
    dragState.isDragging = true;
    dragState.dragType = 'hand-summon';
    dragState.draggedCard = card;
    dragState.startX = e.clientX;
    dragState.startY = e.clientY;
    
    // Update mouse position for visual feedback
    lastMousePos = { x: e.clientX, y: e.clientY };
    
    // Show valid summoning positions for the dragged card
    showValidSummonPositions(handDesktopDragState.draggedCard);
    
    // Change cursor to grabbing during drag
    document.body.style.cursor = 'grabbing';
    
    // Add global mouse event listeners for drag continuation
    document.addEventListener('mousemove', handleHandCardMouseMove);
    document.addEventListener('mouseup', handleHandCardMouseEnd);
    
    // Update canvas to show dragging visuals
    requestDragUpdate();
}

function handleHandCardMouseMove(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (!handDesktopDragState.isDragging) return;
    
    handDesktopDragState.currentX = e.clientX;
    handDesktopDragState.currentY = e.clientY;
    
    // Update mouse position for visual feedback
    lastMousePos = { x: e.clientX, y: e.clientY };
    
    // Update hover preview during drag
    updateHandDragHoverPreview(e.clientX, e.clientY, handDesktopDragState.draggedCard);
    
    // Update canvas for smooth visual feedback
    requestDragUpdate();
}

function handleHandCardMouseEnd(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (!handDesktopDragState.isDragging) return;
    
    // Remove global event listeners
    document.removeEventListener('mousemove', handleHandCardMouseMove);
    document.removeEventListener('mouseup', handleHandCardMouseEnd);
    
    // Restore cursor
    document.body.style.cursor = '';
    
    // Calculate drag distance to determine if this was a drag or click
    const dragDistance = Math.sqrt(
        Math.pow(handDesktopDragState.currentX - handDesktopDragState.startX, 2) +
        Math.pow(handDesktopDragState.currentY - handDesktopDragState.startY, 2)
    );
    
    if (dragDistance < 10) {
        // Short drag distance - treat as click for card selection
        handleCardClick(handDesktopDragState.draggedCard);
    } else {
        // Long drag distance - process as drag-and-drop
        const coords = getCanvasCoordinates({ clientX: handDesktopDragState.currentX, clientY: handDesktopDragState.currentY });
        const targetHex = pixelToHex(coords.x, coords.y);
        
        if (targetHex && isValidHex(targetHex.row, targetHex.col)) {
            // Process the hand card summon
            processHandCardDrag(handDesktopDragState.draggedCard, targetHex.row, targetHex.col);
        }
    }
    
    // Clean up drag state
    handDesktopDragState.isDragging = false;
    handDesktopDragState.draggedCard = null;
    handDesktopDragState.cardElement = null;
    dragState.isDragging = false;
    dragState.dragType = null;
    dragState.draggedCard = null;
    
    // Clear highlights and previews
    clearDragHighlights();
    
    // Update canvas to remove dragging visuals
    updateCanvas();
}

// Mobile touch handlers for hand card dragging
let handMobileDragState = {
    isDragging: false,
    draggedCard: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    cardElement: null
};

function handleHandCardTouchStart(e, card) {
    e.preventDefault();
    e.stopPropagation();
    
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    
    // Haptic feedback on supported devices
    if (navigator.vibrate) {
        navigator.vibrate(50); // Short vibration
    }
    
    // Set up mobile drag state
    handMobileDragState.isDragging = true;
    handMobileDragState.draggedCard = card;
    handMobileDragState.startX = touch.clientX;
    handMobileDragState.startY = touch.clientY;
    handMobileDragState.currentX = touch.clientX;
    handMobileDragState.currentY = touch.clientY;
    handMobileDragState.cardElement = e.target;
    
    // Set up unified drag state for visual feedback
    dragState.isDragging = true;
    dragState.dragType = 'hand-summon';
    dragState.draggedCard = card;
    dragState.startX = touch.clientX;
    dragState.startY = touch.clientY;
    
    // Update mouse position for visual feedback
    lastMousePos = { x: touch.clientX, y: touch.clientY };
    
    // Show valid summoning positions for the dragged card
    showValidSummonPositions(handMobileDragState.draggedCard);
    
    // Update canvas to show dragging visuals
    requestDragUpdate();
}

function handleHandCardTouchMove(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (!handMobileDragState.isDragging || e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    handMobileDragState.currentX = touch.clientX;
    handMobileDragState.currentY = touch.clientY;
    
    // Update mouse position for visual feedback
    lastMousePos = { x: touch.clientX, y: touch.clientY };
    
    // Update hover preview during drag
    updateHandDragHoverPreview(touch.clientX, touch.clientY, handMobileDragState.draggedCard);
    
    // Update canvas for smooth visual feedback
    requestDragUpdate();
}

function handleHandCardTouchEnd(e) {
    e.preventDefault();
    e.stopPropagation();
    
    if (!handMobileDragState.isDragging) return;
    
    // Calculate drag distance to determine if this was a drag or tap
    const dragDistance = Math.sqrt(
        Math.pow(handMobileDragState.currentX - handMobileDragState.startX, 2) +
        Math.pow(handMobileDragState.currentY - handMobileDragState.startY, 2)
    );
    
    if (dragDistance < 10) {
        // Short drag distance - treat as tap for card selection
        handleCardClick(handMobileDragState.draggedCard);
    } else {
        // Long drag distance - process as drag-and-drop
        const coords = getCanvasCoordinates({ clientX: handMobileDragState.currentX, clientY: handMobileDragState.currentY });
        const targetHex = pixelToHex(coords.x, coords.y);
        
        if (targetHex && isValidHex(targetHex.row, targetHex.col)) {
            // Process the hand card summon
            processHandCardDrag(handMobileDragState.draggedCard, targetHex.row, targetHex.col);
        }
    }
    
    // Clean up drag state
    handMobileDragState.isDragging = false;
    handMobileDragState.draggedCard = null;
    handMobileDragState.cardElement = null;
    dragState.isDragging = false;
    dragState.dragType = null;
    dragState.draggedCard = null;
    
    // Clear highlights and previews
    clearDragHighlights();
    
    // Update canvas to remove dragging visuals
    updateCanvas();
}

function processHandCardDrag(card, targetRow, targetCol) {
    // Try to summon the card at the target location
    if (canSummonCard(card, targetRow, targetCol)) {
        // Select the card and place it
        gameState.selectedCard = card;
        handleHexClick(targetRow, targetCol);
    } else {
        // Invalid summon location - show feedback
        showInvalidActionFeedback();
    }
}

function canMoveCard(card, startHex, targetHex) {
    // Check if the card can move from startHex to targetHex
    if (!card || !startHex || !targetHex) return false;
    
    const { row: fromRow, col: fromCol } = startHex;
    const { row: toRow, col: toCol } = targetHex;
    
    // Check if target hex is valid and empty
    if (!isValidHex(toRow, toCol)) return false;
    if (gameState.board[toRow][toCol]) return false; // Target hex is occupied
    
    // Check if card can make this move according to game rules
    const validMoves = getValidMoves(card, fromRow, fromCol);
    return validMoves.some(([r, c]) => r === toRow && c === toCol);
}

function canAttackCard(attackerCard, attackerHex, targetCard, targetHex) {
    // Check if the attacker can attack the target
    if (!attackerCard || !attackerHex || !targetCard || !targetHex) return false;
    
    const { row: fromRow, col: fromCol } = attackerHex;
    const { row: toRow, col: toCol } = targetHex;
    
    // Cannot attack own cards
    if (attackerCard.owner === targetCard.owner) return false;
    
    // Check if target hex is valid and occupied by enemy
    if (!isValidHex(toRow, toCol)) return false;
    if (!gameState.board[toRow][toCol]) return false; // Target hex is empty
    
    // Check if card can attack this target according to game rules
    const validAttacks = getValidAttacks(attackerCard, fromRow, fromCol);
    return validAttacks.some(([r, c]) => r === toRow && c === toCol);
}

function canSummonAtPosition(card, row, col) {
    // Check if a card can be summoned at the given position during play phase
    if (!isValidHex(row, col)) return false;
    
    // Find leader position
    const leaderPos = findLeaderPosition(gameState.currentPlayer);
    if (!leaderPos) return false; // No leader on board
    
    // Check if the placement position is adjacent to the leader
    const [leaderRow, leaderCol] = leaderPos;
    const neighbors = getHexNeighbors(leaderRow, leaderCol);
    const isAdjacentToLeader = neighbors.some(([r, c]) => r === row && c === col);
    
    if (!isAdjacentToLeader) return false;
    
    // Check if leader has already been used this turn (one action limit)
    if (gameState.leaderAttackedThisTurn) return false;
    
    // Check if target position is empty or contains own card (replacement allowed)
    const existingCard = gameState.board[row][col];
    if (existingCard && existingCard.owner !== gameState.currentPlayer) {
        return false; // Cannot summon on enemy card
    }
    
    return true;
}

function isValidSetupPosition(row, col, player) {
    // During setup phase, players can place cards anywhere on valid hexes
    // The main restrictions are based on setup limits, not position
    if (!isValidHex(row, col)) return false;
    
    // Can place on empty hex or replace own card
    const existingCard = gameState.board[row][col];
    if (existingCard && existingCard.owner !== player) {
        return false; // Cannot place on enemy card during setup
    }
    
    return true;
}

function canSummonCard(card, row, col) {
    // Check if the card can be summoned at this location
    // This should match the existing summon validation logic
    
    if (!isValidHex(row, col)) return false;
    
    if (gameState.phase === 'setup') {
        // Setup phase summon rules
        return isValidSetupPosition(row, col, gameState.currentPlayer);
    } else {
        // Play phase summon rules
        return canSummonAtPosition(card, row, col);
    }
}

function handleBoardCardDrop(e, targetHex, dragData) {
    const [, cardId, sourceRow, sourceCol] = dragData.split(':');
    const card = draggedCard; // Should be set from dragstart
    
    console.log(`Dropping board card ${card.value}${card.suit} at (${targetHex.row},${targetHex.col})`);
    
    // Check if we're attacking an enemy card
    const targetCard = gameState.board[targetHex.row][targetHex.col];
    if (targetCard && targetCard.owner !== card.owner) {
        // Perform attack if it's a valid target
        if (gameState.validAttacks && gameState.validAttacks.some(([r, c]) => r === targetHex.row && c === targetHex.col)) {
            performAttack(targetHex.row, targetHex.col);
            return;
        }
    }
    
    // Check if we're moving to a valid move position
    if (gameState.validMoves && gameState.validMoves.some(([r, c]) => r === targetHex.row && c === targetHex.col)) {
        moveCard(parseInt(sourceRow), parseInt(sourceCol), targetHex.row, targetHex.col, card);
        return;
    }
    
    console.log('Invalid drop target for board card');
}

// Throttled drag update for better performance
function requestDragUpdate() {
    if (!dragUpdateRequested) {
        dragUpdateRequested = true;
        requestAnimationFrame(() => {
            updateCanvas();
            dragUpdateRequested = false;
        });
    }
}

// Start dragging a card from hand
function startHandCardDrag(card, x, y) {
    dragState.isDragging = true;
    dragState.dragType = 'hand-summon';
    dragState.draggedCard = card;
    dragState.startX = x;
    dragState.startY = y;
    
    // Legacy compatibility
    isDraggingCard = true;
    draggedCard = card;
    
    console.log(`Started hand drag with ${card.value}${card.suit}`);
}

// Handle hand summon drag end
function handleHandSummonDragEnd(targetHex) {
    const card = dragState.draggedCard;
    
    // Check if it's a valid summoning position
    if (gameState.validMoves && gameState.validMoves.some(([r, c]) => r === targetHex.row && c === targetHex.col)) {
        placeCard(card, targetHex.row, targetHex.col);
    } else {
        console.log('Invalid summoning position');
    }
}

// Strict priority: Attack > Move > Select
function updateCursor(row, col) {
    const canvas = document.getElementById('hex-canvas');
    // Remove all cursor classes
    canvas.className = canvas.className.replace(/\bcursor-\w+\b/g, '');
    canvas.className = canvas.className.replace(/\bcan-\w+\b/g, '');
    canvas.className = canvas.className.replace(/\bblocked\b/g, '');
    canvas.className = canvas.className.replace(/\bdragging\b/g, '');

    // Default
    let cursor = 'default';

    if (isDraggingMap || isDraggingCard) {
        canvas.classList.add('dragging');
        cursor = 'grabbing';
    } else if (row === null || col === null) {
        canvas.classList.add('cursor-default');
        cursor = 'default';
    } else {
        const hoveredCard = gameState.board[row][col];
        if (gameState.phase === 'setup') {
            if (gameState.selectedCard) {
                canvas.classList.add('can-place');
                cursor = 'copy';
            } else if (hoveredCard && hoveredCard.owner === gameState.currentPlayer) {
                canvas.classList.add('can-select');
                cursor = 'pointer';
            } else {
                canvas.classList.add('cursor-default');
                cursor = 'default';
            }
        } else if (gameState.phase === 'play') {
            const isValidMove = gameState.validMoves && gameState.validMoves.some(([r, c]) => r === row && c === col);
            const isValidAttack = gameState.validAttacks && gameState.validAttacks.some(([r, c]) => r === row && c === col);
            const isBlocked = gameState.blockedMoves && gameState.blockedMoves.some(([r, c]) => r === row && c === col);
            // Priority: Attack > Move > Select
            if (isValidAttack) {
                canvas.classList.add('can-attack');
                cursor = 'crosshair';
            } else if (isValidMove) {
                canvas.classList.add('can-move');
                cursor = 'move';
            // } else if (isBlocked) {
            //     canvas.classList.add('blocked');
            //     cursor = 'not-allowed';
            } else if (hoveredCard && hoveredCard.owner === gameState.currentPlayer && !isCardExhausted(hoveredCard)) {
                canvas.classList.add('can-select');
                cursor = 'pointer';
            } else if (hoveredCard && hoveredCard.owner !== gameState.currentPlayer) {
                canvas.classList.add('cursor-help');
                cursor = 'help';
            } else {
                canvas.classList.add('cursor-default');
                cursor = 'default';
            }
        } else {
            canvas.classList.add('cursor-default');
            cursor = 'default';
        }
    }
    // Always set style.cursor for reliability
    canvas.style.cursor = cursor;
}

function handleCanvasClick(event) {
    // Don't handle clicks if we just finished a drag
    if (dragState.isDragging) return;
    
    const coords = getCanvasCoordinates(event);
    const hex = pixelToHex(coords.x, coords.y);
    if (hex) {
        handleHexClick(hex.row, hex.col, event.ctrlKey);
    }
}

// Card and hand management
function drawCards(player, count) {
    const playerData = gameState.players[player];
    for (let i = 0; i < count && playerData.deck.length > 0; i++) {
        const card = playerData.deck.pop();
        playerData.hand.push(card);
    }
}

function createCardElement(card, showFaceDown = false) {
    const cardEl = document.createElement('div');
    cardEl.className = `card ${card.suit} player${card.owner}`;
    cardEl.dataset.cardId = card.id;
    cardEl.draggable = true;
    
    // Set transparent background for cards (except face-down cards)
    cardEl.style.backgroundColor = 'transparent';
    cardEl.style.color = 'white';
    
    if (showFaceDown || card.faceDown) {
        cardEl.classList.add('face-down');
        cardEl.style.backgroundColor = '#4a4a4a';
        cardEl.innerHTML = '?';
    } else {
        // Show card number and suit
        if (card.suit === 'joker') {
            cardEl.innerHTML = '<div class="card-value">G</div>';
        } else {
            const playerColor = getPlayerColor(card);
            const suitColor = getSuitColor(card.suit, card);
            cardEl.innerHTML = `
                <div class="card-value" style="color: ${playerColor};">${card.value}</div>
                <div class="card-suit" style="color: ${suitColor};">${suitSymbols[card.suit]}</div>
            `;
        }
    }
    
    if (isCardExhausted(card)) cardEl.classList.add('rotated');
    
    // Add drag listeners based on device capabilities
    if (isTouchDevice) {
        // Mobile touch-based drag
        cardEl.addEventListener('touchstart', (e) => handleHandCardTouchStart(e, card), { passive: false });
        cardEl.addEventListener('touchmove', handleHandCardTouchMove, { passive: false });
        cardEl.addEventListener('touchend', handleHandCardTouchEnd, { passive: false });
    } else {
        // Desktop mouse-based drag (same logic as mobile)
        cardEl.addEventListener('mousedown', (e) => handleHandCardMouseStart(e, card));
        cardEl.addEventListener('mousemove', handleHandCardMouseMove);
        cardEl.addEventListener('mouseup', handleHandCardMouseEnd);
        // Prevent default drag behavior
        cardEl.draggable = false;
    }
    
    cardEl.addEventListener('click', () => handleCardClick(card));
    
    // Add card info tooltip
    const cardInfo = document.createElement('div');
    cardInfo.className = 'card-info';
    cardInfo.innerHTML = getCardAbilityText(card);
    cardEl.appendChild(cardInfo);
    
    return cardEl;
}

function getCardAbilityText(card) {
    let abilities = [];
    
    if (card.suit === 'hearts') {
        abilities.push('Can attack 2 hexes away (blockable)');
    } else if (card.suit === 'diamonds') {
        abilities.push('Can jump 2 hexes over other cards');
    } else if (card.suit === 'spades') {
        abilities.push('Absorbs attacks on adjacent allies when straight');
    } else if (card.suit === 'clubs') {
        abilities.push('Blocks enemy movement in 6 adjacent hexes');
    } else if (card.suit === 'joker') {
        abilities.push('Leader: Can summon 1 card per turn');
    }
    
    return abilities.join(', ') || 'Standard movement and attack';
}

// Event handlers
function handleHexClick(row, col, ctrlKey = false) {
    if (gameState.phase === 'setup') {
        handleSetupClick(row, col);
    } else if (gameState.phase === 'play') {
        handlePlayClick(row, col, ctrlKey);
    }
}

function handleSetupClick(row, col) {
    if (gameState.setupStep === 'place-cards') {
        if (gameState.selectedCard) {
            // Place selected card
            const card = gameState.selectedCard;
            const currentPlayer = gameState.currentPlayer;
            
            // Check setup limits before placing
            const isLeader = card.suit === 'joker';
            const hasLeaderAlready = gameState.setupLeaderPlaced[currentPlayer];
            const cardsPlaced = gameState.setupCardsPlaced[currentPlayer];
            
            // Prevent placing more than allowed
            if (isLeader && hasLeaderAlready) {
                console.log('Cannot place more than 1 Leader');
                return;
            }
            if (!isLeader && (cardsPlaced - (hasLeaderAlready ? 1 : 0)) >= 5) {
                console.log('Cannot place more than 5 regular cards');
                return;
            }
            if (cardsPlaced >= 6) {
                console.log('Cannot place more than 6 total cards (1 Leader + 5 regular)');
                return;
            }
            
            // If there's already a card, replace it
            if (gameState.board[row][col] && gameState.board[row][col].owner === gameState.currentPlayer) {
                const replacedCard = gameState.board[row][col];
                gameState.players[gameState.currentPlayer].hand.push(replacedCard);
            }
            
            // Cards placed in setup are face down (except jokers/leaders)
            if (card.suit !== 'joker') {
                card.faceDown = true;
                console.log(`Setup card ${card.value}${card.suit} placed face down`);
            }
            
            gameState.board[row][col] = card;
            gameState.players[gameState.currentPlayer].hand = 
                gameState.players[gameState.currentPlayer].hand.filter(c => c.id !== card.id);
            gameState.setupCardsPlaced[gameState.currentPlayer]++;
            
            // Track if this is a leader being placed
            const isLeaderPlacement = card.suit === 'joker';
            
            // If this is a leader being placed, update the leader position and track it
            if (isLeaderPlacement) {
                gameState.players[gameState.currentPlayer].leaderPosition = [row, col];
                gameState.setupLeaderPlaced[gameState.currentPlayer] = true;
            }
            
            clearSelection();
            
            // After placing a card, check if both players have completed setup
            const player1Done = gameState.setupLeaderPlaced[1] && gameState.setupCardsPlaced[1] >= 6;
            const player2Done = gameState.setupLeaderPlaced[2] && gameState.setupCardsPlaced[2] >= 6;
            
            if (player1Done && player2Done) {
                // Both players finished setup, start Play mode immediately
                console.log('Phase transition: Setup -> Play');
                gameState.phase = 'play';
                gameState.currentPlayer = determineFirstPlayer();
                console.log(`First player determined: ${gameState.currentPlayer}, AI enabled: ${aiEnabled[gameState.currentPlayer]}`);
                updateMapRotation(); // Set map rotation for play mode
                updateScreenWakeLock(); // Activate wake lock for AI vs AI mode
                showBattleCaption();
                setTimeout(() => {
                    showPlayerTurnCaption(gameState.currentPlayer);
                }, 2500);
                startNewTurn();
            } else if (isLeaderPlacement) {
                // Auto end turn immediately after placing leader
                console.log('Leader placed - ending turn automatically');
                endTurn();
            } else {
                // Auto end turn after regular card placement in setup
                endTurn();
            }
        }
    }
    
    updateCanvas();
    updateUI();
    saveGameState(); // Save state after setup changes
}

function handlePlayClick(row, col, ctrlKey = false) {
    const clickedCard = gameState.board[row][col];
    
    // Clear mobile hover state for non-attack actions
    if (isMobileHovering) {
        clearMobileHover();
    }
    
    if (!clickedCard) {
        // Clicking empty grid
        if (gameState.selectedCard) {
            // Check if selected card is from hand (summoning)
            const selectedCardPos = findCardPosition(gameState.selectedCard);
            if (!selectedCardPos) {
                // Selected card is from hand - try to summon
                handleHandCardSummoning(row, col);
            } else {
                // Try to move the selected card on board
                handleSingleCardPlay(row, col, null);
            }
        } else if (gameState.selectedCards.length > 0 || isMobileMultiSelectMode) {
            // Clear multi-selection when tapping empty space
            clearSelection();
        } else {
            // No card selected - just clear selection
            clearSelection();
        }
    } else if (gameState.selectedCard) {
        // Check if selected card is from hand (summoning) or from board (attack/move)
        const selectedCardPos = findCardPosition(gameState.selectedCard);
        if (!selectedCardPos) {
            // Selected card is from hand - prioritize summoning over card selection
            if (clickedCard.owner === gameState.currentPlayer) {
                // Check if this is a valid summoning position (adjacent to leader)
                const isValidSummonPosition = gameState.validMoves.some(([r, c]) => r === row && c === col);
                if (isValidSummonPosition) {
                    // Perform replacement summoning
                    handleHandCardSummoning(row, col);
                } else {
                    // Not a valid summoning position, fall back to normal card selection
                    handleMobileCardSelection(clickedCard, row, col, ctrlKey);
                }
            } else {
                console.log('Cannot summon: Position occupied by enemy card');
            }
        } else {
            // Single card selected from board - handle attacks or card selection
            if (clickedCard.owner !== gameState.currentPlayer) {
                // Enemy card - try to attack
                handleSingleCardPlay(row, col, clickedCard);
            } else {
                // Friendly card - normal selection behavior
                handleMobileCardSelection(clickedCard, row, col, ctrlKey);
            }
        }
    } else if (clickedCard.owner === gameState.currentPlayer) {
        // No card selected - normal friendly card selection
        handleMobileCardSelection(clickedCard, row, col, ctrlKey);
    } else if (gameState.selectedCards && gameState.selectedCards.length > 0) {
        // Clicking enemy card with multi-selection - try combined attack
        if (gameState.validAttacks.some(([r, c]) => r === row && c === col)) {
            // Save state before combined attack
            saveStateToHistory();
            performCombinedAttack(row, col);
            clearSelection();
        }
    }
    
    updateCanvas();
    updateUI();
    saveGameState(); // Save state after play actions
}

function handleSingleCardPlay(row, col, clickedCard) {
    if (gameState.selectedCard) {
        const selectedPos = findCardPosition(gameState.selectedCard);
        
        if (gameState.validMoves.some(([r, c]) => r === row && c === col)) {
            // Save state before moving
            saveStateToHistory();
            // Move card
            moveCard(selectedPos[0], selectedPos[1], row, col);
            // Recalculate valid attacks for the new position
            const newValidAttacks = getValidAttacks(gameState.selectedCard, row, col);
            
            // Keep card selected after movement and update the selected hex position
            gameState.selectedHex = [row, col];
            // Update valid actions for the new position - no more moves allowed after moving
            gameState.validMoves = []; // Can't move again this turn
            gameState.validAttacks = newValidAttacks;
            gameState.blockedMoves = getBlockedMoves(gameState.selectedCard, row, col);
            gameState.absorptions = getAbsorptions(gameState.selectedCard, row, col);
            
            // If no valid attacks, clear selection (card is done for the turn)
            if (newValidAttacks.length === 0) {
                clearSelection();
            }
        } else if (gameState.validAttacks.some(([r, c]) => r === row && c === col)) {
            // Save state before attacking
            saveStateToHistory();
            // Attack
            attack(selectedPos[0], selectedPos[1], row, col);
            clearSelection();
        } else if (clickedCard && clickedCard.owner === gameState.currentPlayer) {
            // Select different card
            selectCard(clickedCard, row, col);
        } else {
            clearSelection();
        }
    } else if (clickedCard && clickedCard.owner === gameState.currentPlayer) {
        // Select card
        selectCard(clickedCard, row, col);
    }
}

function handleCardClick(card) {
    if (gameState.phase === 'setup' && gameState.setupStep === 'place-cards') {
        if (card.owner === gameState.currentPlayer) {
            // Check if leader has been placed
            const currentPlayerData = gameState.players[gameState.currentPlayer];
            const leaderOnBoard = findLeaderPosition(gameState.currentPlayer);
            
            // If leader hasn't been placed yet
            if (!leaderOnBoard) {
                // Only allow selecting the leader card
                if (card.suit === 'joker') {
                    gameState.selectedCard = card;
                    updateUI();
                } else {
                    // Prevent selecting regular cards until leader is placed
                    console.log('Leader must be placed first before other cards');
                    return;
                }
            } else {
                // Leader is placed, allow selecting any remaining card
                gameState.selectedCard = card;
                updateUI();
            }
        }
    } else if (gameState.phase === 'play' && card.owner === gameState.currentPlayer) {
        // Mobile: Allow selecting cards from hand for summoning when leader hasn't summoned
        const currentPos = findCardPosition(card);
        if (!currentPos) {
            // Card is in hand
            handleHandCardSelection(card);
        }
    } else if (gameState.phase === 'setup' && gameState.setupStep === 'discard') {
        if (card.owner === gameState.currentPlayer) {
            // Discard card (SAFETY: Never discard leaders!)
            const playerData = gameState.players[gameState.currentPlayer];
            if (protectLeaderFromRemoval(card, "setup discard")) {
                playerData.hand = playerData.hand.filter(c => c.id !== card.id);
                playerData.discarded.push(card);
            } else {
                // Leader cannot be discarded, keep in hand
                console.warn('Leader discard blocked during setup - keeping in hand');
                return;
            }
            
            // Check if hand is at 5 cards
            if (playerData.hand.length === 5) {
                if (gameState.currentPlayer === 1) {
                    gameState.currentPlayer = 2;
                } else {
                    // Both players finished setup, start game
                    console.log('Phase transition: Setup -> Play (discard complete)');
                    gameState.phase = 'play';
                    gameState.currentPlayer = determineFirstPlayer();
                    console.log(`First player determined: ${gameState.currentPlayer}, AI enabled: ${aiEnabled[gameState.currentPlayer]}`);
                    updateMapRotation(); // Set map rotation for play mode
                    updateScreenWakeLock(); // Activate wake lock for AI vs AI mode
                    showBattleCaption();
                    setTimeout(() => {
                        showPlayerTurnCaption(gameState.currentPlayer);
                    }, 2500);
                    startNewTurn();
                }
            }
            updateUI();
            saveGameState(); // Save state after card actions
        }
    }
}

function handleMultiSelection(card, row, col) {
    // Check if this card can attack (not exhausted and hasn't attacked yet)
    if (gameState.cardsAttackedThisTurn.has(card.id) || isCardExhausted(card)) {
        return; // Can't select exhausted cards for attacks
    }
    
    // Leaders cannot be multi-selected
    if (card.suit === 'joker') {
        return; // Leaders can only be selected individually
    }
    
    // If we have a single card selected, transfer it to multi-selection first (unless it's a leader)
    if (gameState.selectedCard && gameState.selectedHex && gameState.selectedCard.suit !== 'joker') {
        const alreadyInMulti = gameState.selectedCards.some(selected => selected.card.id === gameState.selectedCard.id);
        if (!alreadyInMulti) {
            gameState.selectedCards.push({
                card: gameState.selectedCard,
                position: gameState.selectedHex
            });
        }
    }
    
    // Toggle card in multi-selection
    const cardIndex = gameState.selectedCards.findIndex(selected => selected.card.id === card.id);
    
    if (cardIndex >= 0) {
        // Remove from selection
        gameState.selectedCards.splice(cardIndex, 1);
    } else {
        // Add to selection
        gameState.selectedCards.push({
            card: card,
            position: [row, col]
        });
    }
    
    // Calculate combined valid attacks
    calculateCombinedAttacks();
    
    // Clear single card selection when using multi-selection
    gameState.selectedCard = null;
    gameState.selectedHex = null;
    gameState.validMoves = [];
}

function calculateCombinedAttacks() {
    if (!gameState.selectedCards || gameState.selectedCards.length === 0) {
        gameState.validAttacks = [];
        gameState.absorptions = [];
        return;
    }
    
    // Find targets that ALL selected cards can attack (intersection)
    let commonTargets = null;
    let commonAbsorptions = null;
    
    for (const selected of gameState.selectedCards) {
        const cardAttacks = getValidAttacks(selected.card, selected.position[0], selected.position[1]);
        const cardAbsorptions = getAbsorptions(selected.card, selected.position[0], selected.position[1]);
        
        if (commonTargets === null) {
            // First card - use its targets as the starting set
            commonTargets = cardAttacks;
            commonAbsorptions = cardAbsorptions;
        } else {
            // Keep only targets that this card can also attack
            commonTargets = commonTargets.filter(([r1, c1]) => 
                cardAttacks.some(([r2, c2]) => r1 === r2 && c1 === c2)
            );
            
            // Keep only absorptions that this card can also provide
            commonAbsorptions = commonAbsorptions.filter(abs1 => 
                cardAbsorptions.some(abs2 => 
                    abs1.target[0] === abs2.target[0] && abs1.target[1] === abs2.target[1]
                )
            );
        }
    }
    
    gameState.validAttacks = commonTargets || [];
    gameState.absorptions = commonAbsorptions || [];
    
    console.log('Combined attacks calculated for', gameState.selectedCards.length, 'cards:', gameState.validAttacks.length, 'common targets');
}

function handleMobileCardSelection(clickedCard, row, col, ctrlKey = false) {
    console.log('handleMobileCardSelection called:', clickedCard.value + clickedCard.suit, 'at', row, col);
    
    // Leaders use single selection only
    if (clickedCard.suit === 'joker') {
        console.log('Leader clicked - single selection only');
        exitMobileMultiSelectMode();
        clearSelection();
        selectCard(clickedCard, row, col);
        return;
    }
    
    // Regular cards always use multi-selection
    console.log('Regular card clicked - adding to multi-selection');
    
    // Ensure we're in multi-select mode
    isMobileMultiSelectMode = true;
    
    // Clear any single selection if it exists
    if (gameState.selectedCard) {
        gameState.selectedCard = null;
        gameState.selectedHex = null;
        gameState.validMoves = [];
    }
    
    // Check if this card is already in multi-selection
    const cardIndex = gameState.selectedCards.findIndex(selected => selected.card.id === clickedCard.id);
    
    if (cardIndex >= 0) {
        // Card is already selected - remove it (toggle off)
        console.log('Removing card from multi-selection:', clickedCard.value + clickedCard.suit);
        gameState.selectedCards.splice(cardIndex, 1);
    } else {
        // Card is not selected - add it (toggle on)
        console.log('Adding card to multi-selection:', clickedCard.value + clickedCard.suit);
        gameState.selectedCards.push({
            card: clickedCard,
            position: [row, col]
        });
    }
    
    // If no cards left in multi-selection, exit multi-select mode
    if (gameState.selectedCards.length === 0) {
        console.log('No cards left - exiting multi-select mode');
        exitMobileMultiSelectMode();
        clearSelection();
        return;
    }
    
    // Calculate combined attacks for selected cards
    calculateCombinedAttacks();
    console.log('Multi-selection updated, total cards:', gameState.selectedCards.length);
}

function exitMobileMultiSelectMode() {
    isMobileMultiSelectMode = false;
}

function handleHandCardSelection(card) {
    // Check if leader can summon (hasn't summoned this turn)
    const leaderPos = findLeaderPosition(gameState.currentPlayer);
    if (!leaderPos) {
        console.log('Cannot select hand card: Leader not on board');
        return;
    }
    
    if (gameState.leaderAttackedThisTurn) {
        console.log('Cannot select hand card: Leader already used this turn');
        return;
    }
    
    // Clear any existing selection
    clearSelection();
    
    // Select the hand card and show valid summoning positions
    gameState.selectedCard = card;
    
    // Show valid summoning positions (mimicking drag behavior)
    const mapCounts = countCardsOnMap(gameState.currentPlayer);
    const isAtMaxCapacity = mapCounts.leaderCount >= 1 && mapCounts.regularCards >= 5;
    const neighbors = getHexNeighbors(leaderPos[0], leaderPos[1]);
    
    if (isAtMaxCapacity) {
        // At max capacity - only show positions with existing cards to replace
        gameState.validMoves = neighbors.filter(([r, c]) => {
            const existingCard = gameState.board[r][c];
            return existingCard && existingCard.owner === gameState.currentPlayer;
        });
        // All valid moves will result in discarding the existing card
        validDiscards = [...gameState.validMoves];
    } else {
        // Not at max - show all valid summoning positions (empty or own cards)
        gameState.validMoves = neighbors.filter(([r, c]) => {
            const existingCard = gameState.board[r][c];
            return !existingCard || existingCard.owner === gameState.currentPlayer;
        });
        // Only positions with existing friendly cards will be discarded
        validDiscards = neighbors.filter(([r, c]) => {
            const existingCard = gameState.board[r][c];
            return existingCard && existingCard.owner === gameState.currentPlayer;
        });
    }
    
    // Clear other action arrays since this is for summoning only
    gameState.validAttacks = [];
    gameState.blockedMoves = [];
    gameState.absorptions = [];
    
    updateCanvas();
    updateUI();
}

function handleHandCardSummoning(row, col) {
    const selectedCard = gameState.selectedCard;
    if (!selectedCard) return;
    
    // Validate summoning position
    if (gameState.validMoves.some(([r, c]) => r === row && c === col)) {
        const existingCard = gameState.board[row][col];
        
        // Can summon to empty positions or positions with your own cards
        if (!existingCard || existingCard.owner === gameState.currentPlayer) {
            // Save state before summoning for undo functionality
            saveStateToHistory();
            
            // Log the action type for clarity
            if (existingCard) {
                console.log(`Replacing ${existingCard.value}${existingCard.suit} with ${selectedCard.value}${selectedCard.suit} via mobile tap`);
            } else {
                console.log(`Summoning ${selectedCard.value}${selectedCard.suit} to empty position via mobile tap`);
            }
            
            // Try to summon the card (placeCard will handle replacement)
            const placementSuccessful = placeCard(selectedCard, row, col);
            if (placementSuccessful) {
                gameState.leaderAttackedThisTurn = true; // Mark leader as used for summoning
                console.log('Card summoned/replaced successfully via mobile tap');
                clearSelection(); // Clear selection after successful summoning
            } else {
                console.log('Failed to summon/replace card via mobile tap');
            }
        } else {
            console.log('Cannot summon: Position occupied by enemy card');
        }
    } else {
        console.log('Cannot summon: Invalid summoning position (not adjacent to leader or leader already used)');
    }
}

function calculateAttackResults(targetRow, targetCol) {
    const target = gameState.board[targetRow][targetCol];
    if (!target) return null;
    
    // Don't show attack results when target is face down
    if (target.faceDown && target.owner !== gameState.currentPlayer) {
        return null;
    }
    
    let attackers = [];
    let totalAttack = 0;
    
    // Get attackers from either multi-selection or single selection
    if (gameState.selectedCards && gameState.selectedCards.length > 0) {
        attackers = gameState.selectedCards.map(selected => selected.card);
        totalAttack = attackers.reduce((sum, card) => sum + card.attack, 0);
    } else if (gameState.selectedCard) {
        attackers = [gameState.selectedCard];
        totalAttack = gameState.selectedCard.attack;
    } else {
        return null;
    }
    
    // Check for spade absorption
    const firstAttacker = gameState.selectedCards && gameState.selectedCards.length > 0 
        ? gameState.selectedCards[0] 
        : { position: gameState.selectedHex };
    const absorber = findSpadeAbsorber(
        firstAttacker.position[0], firstAttacker.position[1], 
        targetRow, targetCol, target.owner
    );
    const actualDefender = absorber || target;
    
    const results = {
        targetCaptured: false,
        attackersCasualites: [],
        survivingAttackers: [],
        actualDefender: actualDefender,
        totalAttack: totalAttack,
        isLeaderAttack: false,
        captureTokensAdded: 0
    };
    
    // Handle different target types
    if (actualDefender.suit === 'joker') {
        // Attacking a Leader
        results.isLeaderAttack = true;
        results.captureTokensAdded = 3;
        results.targetCaptured = false; // Leader stays on board
        results.survivingAttackers = [...attackers]; // All attackers survive (no counter-attack from Leader)
    } else if (totalAttack >= actualDefender.defense) {
        // Regular unit is defeated
        results.targetCaptured = true;
        results.captureTokensAdded = 1;
        
        // Check which attackers survive counter-attack
        const counterAttack = actualDefender.attack;
        attackers.forEach(attacker => {
            if (attacker.defense <= counterAttack) {
                results.attackersCasualites.push(attacker);
            } else {
                results.survivingAttackers.push(attacker);
            }
        });
    } else {
        // Target survives, check for attacker casualties from counter-attack
        results.targetCaptured = false;
        results.captureTokensAdded = 0;
        
        const counterAttack = actualDefender.attack;
        attackers.forEach(attacker => {
            if (attacker.defense <= counterAttack) {
                results.attackersCasualites.push(attacker);
            } else {
                results.survivingAttackers.push(attacker);
            }
        });
    }
    
    return results;
}

function performCombinedAttack(targetRow, targetCol) {
    const target = gameState.board[targetRow][targetCol];
    if (!target) return;
    
    // Show attack animation for all attacking cards
    startAttackAnimation(gameState.selectedCards, [targetRow, targetCol]);
    
    // Automatically face up all cards involved in attack
    // Face up all attacking cards
    for (const selected of gameState.selectedCards) {
        if (selected.card.faceDown) {
            selected.card.faceDown = false;
            console.log(`Attacker ${selected.card.value}${selected.card.suit} automatically faced up for combined attack`);
        }
    }
    
    // Face up the defender
    if (target.faceDown) {
        target.faceDown = false;
        console.log(`Defender ${target.value}${target.suit} automatically faced up for defense`);
    }
    
    // Calculate combined attack power
    let totalAttack = 0;
    for (const selected of gameState.selectedCards) {
        totalAttack += selected.card.attack;
    }
    
    // Check for spade absorption (using first attacker's position)
    const firstAttacker = gameState.selectedCards[0];
    const absorber = findSpadeAbsorber(
        firstAttacker.position[0], firstAttacker.position[1], 
        targetRow, targetCol, target.owner
    );
    const actualDefender = absorber || target;
    
    // Face up spade absorber if it's different from the original target
    if (absorber && absorber !== target && absorber.faceDown) {
        absorber.faceDown = false;
        console.log(`Spade absorber ${absorber.value}${absorber.suit} automatically faced up for defense`);
    }
    
    console.log(`Combined attack: ${totalAttack} vs ${actualDefender.defense}`);
    
    // Handle combined attack resolution
    if (actualDefender.suit === 'joker') {
        // Attacking leader - add 3 to captured stack but don't remove leader
        for (let i = 0; i < 3; i++) {
            gameState.players[gameState.currentPlayer].captured.push({ 
                id: `leader_capture_${Math.random()}`,
                suit: 'capture',
                value: 'CAPTURE',
                owner: actualDefender.owner
            });
        }
        gameState.leaderAttackedThisTurn = true;
        
        // Show leader attack animation
        startLeaderAttackAnimation(actualDefender, [targetRow, targetCol]);
        
        // Leader stays on the board and doesn't counter-attack (0 attack)
        // RULE: All attackers are discarded after attacking the enemy leader
        for (const selected of gameState.selectedCards) {
            if (selected.card.suit === 'joker') {
                console.warn('Leader in combined attack against leader - leader survives but gets exhausted');
                // Leader survives but gets exhausted
            gameState.cardsAttackedThisTurn.add(selected.card.id);
                gameState.cardsMovedThisTurn.add(selected.card.id);
            } else {
                // Regular card in combined attack - discard it
                gameState.players[gameState.currentPlayer].discarded.push(selected.card);
                startFadeOutAnimation(selected.card, selected.position, 'discarded');
                console.log(`Card ${selected.card.suit} ${selected.card.value} discarded after combined attack on enemy leader`);
            }
        }
    } else {
        // Regular combined combat resolution
        const defenderDestroyed = totalAttack >= actualDefender.defense;
        const counterAttack = actualDefender.attack;
        
        if (defenderDestroyed) {
            // Defender is captured - goes to attacker's captured stack (SAFETY: Never capture leaders!)
            if (protectLeaderFromRemoval(actualDefender, "combined attack capture")) {
                gameState.players[gameState.currentPlayer].captured.push(actualDefender);
            } else {
                // Leader cannot be captured, abort the capture
                console.warn('Leader capture blocked - leaders are immortal!');
                return;
            }
            
            // Remove defender from board (SAFETY: Never remove leaders!)
            if (actualDefender.suit === 'joker') {
                console.error('CRITICAL ERROR: Attempted to remove leader from board! This should never happen!');
                return; // Abort the attack to prevent leader removal
            }
            
            if (absorber) {
                // Spade absorbed the attack - remove the spade instead of the original target
                const absorberPos = findCardPosition(actualDefender);
                if (absorber.suit === 'joker') {
                    console.error('CRITICAL ERROR: Attempted to remove absorbing leader! This should never happen!');
                    return;
                }
                startFadeOutAnimation(actualDefender, absorberPos, 'captured');
            } else {
                // No absorption - remove the original target (SAFETY: Never remove leaders!)
                if (target.suit === 'joker') {
                    console.error('CRITICAL ERROR: Attempted to remove leader from board in combined attack! This should never happen!');
                    return;
                }
                startFadeOutAnimation(target, [targetRow, targetCol], 'captured');
            }
        } else {
            // Defender survives - mark as exhausted (unless it's a leader)
            if (actualDefender.suit !== 'joker') {
                gameState.cardsAttackedThisTurn.add(actualDefender.id);
                gameState.cardsMovedThisTurn.add(actualDefender.id); // Mark as exhausted
            }
        }
        
        // Handle counter-attack against all attackers
        for (const selected of gameState.selectedCards) {
            const attacker = selected.card;
            if (counterAttack >= attacker.defense) {
                // SAFETY: Never destroy leaders even in counter-attacks!
                if (attacker.suit === 'joker') {
                    console.warn('Leader would be destroyed by counter-attack, but leaders are immortal!');
                    // Leader survives but gets exhausted
                    gameState.cardsAttackedThisTurn.add(attacker.id);
                    gameState.cardsMovedThisTurn.add(attacker.id);
                } else {
                    // Attacker is destroyed by counter-attack - goes to attacker's discarded stack
                    gameState.players[gameState.currentPlayer].discarded.push(attacker);
                    startFadeOutAnimation(attacker, selected.position, 'discarded');
                }
            } else {
                // Attacker survives - mark as exhausted
                gameState.cardsAttackedThisTurn.add(attacker.id);
                gameState.cardsMovedThisTurn.add(attacker.id); // Mark as exhausted
            }
        }
    }
    
    // Mark all involved cards (attackers and defender) as exhausted for 3 turns total
    // They will be exhausted until turn: current turn + 2
    const exhaustionEndTurn = gameState.turn + 2;
    for (const selected of gameState.selectedCards) {
        gameState.cardsAttackExhaustion.set(selected.card.id, exhaustionEndTurn);
    }
    if (actualDefender && actualDefender.suit !== 'joker') {
        gameState.cardsAttackExhaustion.set(actualDefender.id, exhaustionEndTurn);
    }
    
    // Update drag overlays after combined attack (cards may have been destroyed)
    updateBoardCardOverlays();
    
    // SAFETY: Validate leaders are still on map after combined attack
    if (gameState.phase === 'play') {
        validateLeadersOnMap();
    }
    
    // Check win condition
    checkWinCondition();
}

// Helper function to check if a card is exhausted (used both actions)
function isCardExhausted(card) {
    const hasMoved = gameState.cardsMovedThisTurn.has(card.id);
    const hasAttacked = gameState.cardsAttackedThisTurn.has(card.id);
    
    // Check if card is exhausted from previous attack (3-turn exhaustion)
    const attackExhaustionEndTurn = gameState.cardsAttackExhaustion.get(card.id);
    const isAttackExhausted = attackExhaustionEndTurn && gameState.turn <= attackExhaustionEndTurn;
    
    return (hasMoved && hasAttacked) || isAttackExhausted;
}

// Game logic
function selectCard(card, row, col) {
    console.log('selectCard called for:', card.value + card.suit, 'owner:', card.owner, 'currentPlayer:', gameState.currentPlayer, 'exhausted:', isCardExhausted(card));
    if (card.owner !== gameState.currentPlayer || isCardExhausted(card)) {
        console.log('Selection blocked - wrong owner or exhausted');
        return;
    }
    
    // Card is already checked for exhaustion above
    console.log('Setting selectedCard to:', card.value + card.suit);
    
    // Clear previous highlights first
    gameState.validMoves = [];
    gameState.validAttacks = [];
    gameState.blockedMoves = [];
    gameState.absorptions = [];
    hoveredHex = null;
    hoveredAttackTarget = null;
    attackPreviewResults = null;
    
    // Set selection state
    gameState.selectedCard = card;
    gameState.selectedHex = [row, col];
    
    // Calculate all targets (same as drag logic but without drag state management)
    gameState.validMoves = getValidMoves(card, row, col);
    gameState.validAttacks = getValidAttacks(card, row, col);
    gameState.blockedMoves = getBlockedMoves(card, row, col);
    gameState.absorptions = getAbsorptions(card, row, col);
    
    console.log('selectCard calculated - validAttacks:', gameState.validAttacks.length, 'targets');
    
    // Update canvas to show highlights
    updateCanvas();
    
    // Update cursor after selecting card
    if (hoveredHex) {
        updateCursor(hoveredHex[0], hoveredHex[1]);
    }
}

function clearSelection() {
    gameState.selectedCard = null;
    gameState.selectedHex = null;
    gameState.selectedCards = [];
    gameState.validMoves = [];
    gameState.validAttacks = [];
    gameState.blockedMoves = [];
    gameState.absorptions = [];
    validDiscards = []; // Clear discard markers
    
    // Clear mobile hover state
    if (isMobileHovering) {
        clearMobileHover();
    }
    
    // Exit mobile multi-select mode
    exitMobileMultiSelectMode();
    
    // Update cursor after clearing selection
    if (hoveredHex) {
        updateCursor(hoveredHex[0], hoveredHex[1]);
    }
}



// Helper function to get suit symbol
function getSuitSymbol(suit) {
    switch(suit) {
        case 'hearts': return '♥';
        case 'diamonds': return '♦';
        case 'clubs': return '♣';
        case 'spades': return '♠';
        case 'joker': return '★';
        default: return '';
    }
}

function getValidMoves(card, row, col) {
    const moves = [];
    
    // If card is exhausted (including 3-turn attack exhaustion), no valid moves
    if (isCardExhausted(card)) {
        return moves;
    }
    
    // If card has already moved this turn, no valid moves
    if (gameState.cardsMovedThisTurn.has(card.id)) {
        return moves;
    }
    
    // Face down cards can move normally when selected (treated as face up for movement calculation)
    // But face down cards that aren't selected still have limited movement (EXCEPTION: AI can move its own face-down cards normally)
    const isSelected = gameState.selectedCard === card || 
                      (gameState.selectedCards && gameState.selectedCards.some(selected => selected.card === card));
    const isAIControlled = aiEnabled[card.owner];
    const effectiveFaceDown = card.faceDown && !isSelected && !isAIControlled;
    
    // Debug: Log when AI is calculating moves for face-down cards
    if (card.faceDown && isAIControlled && !isSelected) {
        console.log(`[AI DEBUG] Calculating moves for AI face-down card ${card.value}${card.suit} at [${row},${col}]`);
    }
    
    // Face down unselected cards can only move 1 grid (to adjacent hexes) - unless AI controlled
    if (effectiveFaceDown) {
        const neighbors = getHexNeighbors(row, col);
        for (const [nr, nc] of neighbors) {
            const targetCard = gameState.board[nr][nc];
            // Can only move to empty hexes
            if (!targetCard) {
                moves.push([nr, nc]);
            }
        }
        return moves;
    }
    
    if (card.suit === 'diamonds') {
        // Diamond cards can jump 2 hexes - check each step for blocking
        const neighbors = getHexNeighbors(row, col);
        for (const [nr, nc] of neighbors) {
            const jumpNeighbors = getHexNeighbors(nr, nc);
            for (const [jr, jc] of jumpNeighbors) {
                if (jr !== row || jc !== col) {
                    const targetCard = gameState.board[jr][jc];
                    // Can only move to empty hexes - cannot move to any occupied hex, including own Leader
                    if (!targetCard) {
                        // Check if either step is blocked by clubs
                        const firstStepBlocked = isBlockedByClubs(card, row, col, nr, nc);
                        const secondStepBlocked = isBlockedByClubs(card, nr, nc, jr, jc);
                        if (!firstStepBlocked && !secondStepBlocked) {
                            moves.push([jr, jc]);
                        }
                    }
                }
            }
        }
    } else {
        // Regular movement (1 hex)
        const neighbors = getHexNeighbors(row, col);
        for (const [nr, nc] of neighbors) {
            const targetCard = gameState.board[nr][nc];
            // Can only move to empty hexes - cannot move to any occupied hex, including own Leader
            if (!targetCard) {
                if (!isBlockedByClubs(card, row, col, nr, nc)) {
                    moves.push([nr, nc]);
                }
            }
        }
    }
    
    return moves;
}

function getBlockedMoves(card, row, col) {
    const blockedMoves = [];
    
    // If card has already moved this turn, no potential moves to block
    if (gameState.cardsMovedThisTurn.has(card.id)) {
        return blockedMoves;
    }
    
    if (card.suit === 'diamonds') {
        // Diamond cards can jump 2 hexes - collect all possible destinations and their blocking status
        const destinationPaths = new Map(); // destination -> array of path blocking status
        
        const neighbors = getHexNeighbors(row, col);
        for (const [nr, nc] of neighbors) {
            const jumpNeighbors = getHexNeighbors(nr, nc);
            for (const [jr, jc] of jumpNeighbors) {
                if (jr !== row || jc !== col) {
                    const targetCard = gameState.board[jr][jc];
                    // Check empty spaces that could potentially be reached
                    if (!targetCard) {
                        const destKey = `${jr},${jc}`;
                        const firstStepBlocked = isBlockedByClubs(card, row, col, nr, nc);
                        const secondStepBlocked = isBlockedByClubs(card, nr, nc, jr, jc);
                        const pathBlocked = firstStepBlocked || secondStepBlocked;
                        
                        if (!destinationPaths.has(destKey)) {
                            destinationPaths.set(destKey, []);
                        }
                        destinationPaths.get(destKey).push(pathBlocked);
                    }
                }
            }
        }
        
        // Only add destinations where ALL paths are blocked
        for (const [destKey, pathResults] of destinationPaths) {
            if (pathResults.every(blocked => blocked)) {
                const [jr, jc] = destKey.split(',').map(Number);
                            blockedMoves.push([jr, jc]);
            }
        }
    } else {
        // Regular movement (1 hex)
        const neighbors = getHexNeighbors(row, col);
        for (const [nr, nc] of neighbors) {
            const targetCard = gameState.board[nr][nc];
            // Check empty spaces that would be valid moves if not blocked
            if (!targetCard && isBlockedByClubs(card, row, col, nr, nc)) {
                blockedMoves.push([nr, nc]);
            }
        }
    }
    
    return blockedMoves;
}

function getValidAttacks(card, row, col) {
    const attacks = [];
    
    // If card is exhausted (including 3-turn attack exhaustion), no valid attacks
    if (isCardExhausted(card)) {
        return attacks;
    }
    
    if (gameState.cardsAttackedThisTurn.has(card.id)) {
        return attacks;
    }
    
    // Face down cards can attack normally when selected (treated as face up for attack calculation)
    const isSelected = gameState.selectedCard === card || 
                      (gameState.selectedCards && gameState.selectedCards.some(selected => selected.card === card));
    const isAIControlled = aiEnabled[card.owner];
    const effectiveFaceDown = card.faceDown && !isSelected && !isAIControlled;
    
    // Face down unselected cards cannot attack (EXCEPTION: AI can attack with its own face-down cards)
    if (effectiveFaceDown) {
        return attacks;
    }
    
    // Debug: Log when AI is calculating attacks for face-down cards
    if (card.faceDown && isAIControlled && !isSelected) {
        console.log(`[AI DEBUG] Calculating attacks for AI face-down card ${card.value}${card.suit} at [${row},${col}]`);
    }
    
    // Leaders cannot attack
    if (card.suit === 'joker') {
        return attacks;
    }
    if (card.suit === 'hearts') {
        // BFS for up to 2 steps, blocking on first enemy
        const visited = Array.from({ length: 11 }, () => Array(11).fill(false));
        const queue = [[row, col, 0]]; // [r, c, dist]
        visited[row][col] = true;
        while (queue.length > 0) {
            const [cr, cc, dist] = queue.shift();
            if (dist > 0 && dist <= 2) {
                const target = gameState.board[cr][cc];
                if (target && target.owner !== card.owner) {
                    attacks.push([cr, cc]);
                    // Do not traverse past an enemy
                    continue;
                }
            }
            if (dist < 2) {
                for (const [nr, nc] of getHexNeighbors(cr, cc)) {
                    if (!isValidHex(nr, nc) || visited[nr][nc]) continue;
                    const neighbor = gameState.board[nr][nc];
                    if (!neighbor || neighbor.owner === card.owner) {
                        // Empty or ally: can traverse
                        queue.push([nr, nc, dist + 1]);
                        visited[nr][nc] = true;
                    } else if (neighbor.owner !== card.owner && dist + 1 <= 2) {
                        // Enemy: can attack, but do not traverse further
                        attacks.push([nr, nc]);
                        visited[nr][nc] = true;
                    }
                }
            }
        }
    } else {
        // Regular attack (adjacent hexes)
        const neighbors = getHexNeighbors(row, col);
        for (const [nr, nc] of neighbors) {
            const target = gameState.board[nr][nc];
            if (target) {
                // Prevent attacking your own cards (including your own Leader)
                if (target.owner === card.owner) {
                    console.log('Skipping friendly target');
                    continue; // Skip attacking own cards
                }
                attacks.push([nr, nc]);
            }
        }
    }
    
    return attacks;
}

function getAbsorptions(card, row, col) {
    const absorptions = [];
    
    // Get valid attacks first
    const validAttacks = getValidAttacks(card, row, col);
    
    // For each valid attack, check if it would be absorbed by a spade
    for (const [targetRow, targetCol] of validAttacks) {
        const target = gameState.board[targetRow][targetCol];
        if (target) {
            const absorber = findSpadeAbsorber(row, col, targetRow, targetCol, target.owner);
            if (absorber) {
                const absorberPos = findCardPosition(absorber);
                absorptions.push({
                    target: [targetRow, targetCol],
                    absorber: absorberPos
                });
            }
        }
    }
    
    return absorptions;
}

function isBlockedByClubs(card, fromRow, fromCol, toRow, toCol) {
    // Check if any enemy clubs or spades block this movement
    // Clubs only block movement INTO the blocked area, not OUT of it
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const blockingCard = gameState.board[r][c];
            // Face down cards and exhausted cards cannot block movement
            if (blockingCard && blockingCard.owner !== card.owner && !isCardExhausted(blockingCard) && !blockingCard.faceDown) {
                // Only clubs block movement, spades absorb attacks but don't block movement
                if (blockingCard.suit === 'clubs') {
                    const neighbors = getHexNeighbors(r, c);
                    // Only block if the destination (toRow, toCol) is adjacent to the blocking card
                    if (neighbors.some(([nr, nc]) => nr === toRow && nc === toCol)) {
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

function isAttackBlocked(fromRow, fromCol, toRow, toCol) {
    // Check if there's a card blocking the attack path for hearts
    const dx = toCol - fromCol;
    const dy = toRow - fromRow;
    const distance = getDistance(fromRow, fromCol, toRow, toCol);
    
    if (distance <= 1) return false; // Adjacent attacks aren't blockable
    
    // Check intermediate positions
    for (let i = 1; i < distance; i++) {
        const checkRow = fromRow + Math.round((dy * i) / distance);
        const checkCol = fromCol + Math.round((dx * i) / distance);
        if (gameState.board[checkRow] && gameState.board[checkRow][checkCol]) {
            return true;
        }
    }
    return false;
}

function moveCard(fromRow, fromCol, toRow, toCol) {
    const card = gameState.board[fromRow][fromCol];
    
    // SAFETY: Check if card is exhausted
    if (isCardExhausted(card)) {
        console.error('CRITICAL ERROR: Attempted to move exhausted card! This should never happen!');
        console.error('Movement blocked to maintain game integrity');
        return; // Abort the move
    }
    
    // SAFETY: Leaders can never be captured by movement!
    if (gameState.board[toRow][toCol] && gameState.board[toRow][toCol].suit === 'joker') {
        console.error('CRITICAL ERROR: Attempted to move onto leader position! This should never happen!');
        console.error('Movement blocked to protect leader integrity');
        return; // Abort the move to prevent leader capture
    }
    
    gameState.board[fromRow][fromCol] = null;
    gameState.board[toRow][toCol] = card;
    
    // Check if face down diamond moved 2 steps - automatically face it up
    if (card.faceDown && card.suit === 'diamonds') {
        const distance = getDistance(fromRow, fromCol, toRow, toCol);
        if (distance === 2) {
            card.faceDown = false;
            console.log(`Face down diamond ${card.value}♦ automatically faced up after moving 2 steps`);
        }
    }
    
    // Mark card as moved
    gameState.cardsMovedThisTurn.add(card.id);
    
    // Update drag overlays to reflect new card positions
    updateBoardCardOverlays();
    
    // Auto-select the moved card to show remaining actions (only for human players)
    if (card.owner === gameState.currentPlayer && !aiEnabled[gameState.currentPlayer] && gameState.phase === 'play') {
        setTimeout(() => {
            // Only auto-select if the card has remaining actions
            const hasAttacks = !gameState.cardsAttackedThisTurn.has(card.id) && getValidAttacks(card, toRow, toCol).length > 0;
            if (hasAttacks) {
                selectCard(card, toRow, toCol);
                console.log(`Auto-selected ${card.value}${card.suit} after movement (has ${getValidAttacks(card, toRow, toCol).length} attacks available)`);
            } else {
                console.log(`Skipped auto-selection of ${card.value}${card.suit} - no remaining actions`);
            }
        }, 100); // Small delay to ensure UI updates properly
    }
}

function attack(fromRow, fromCol, toRow, toCol) {
    const attacker = gameState.board[fromRow][fromCol];
    const defender = gameState.board[toRow][toCol];
    
    if (!defender) return;
    
    // Show attack animation for the attacking card
    startAttackAnimation([attacker], [toRow, toCol]);
    
    // SAFETY: Check if attacker is exhausted
    if (isCardExhausted(attacker)) {
        console.error('CRITICAL ERROR: Attempted to attack with exhausted card! This should never happen!');
        console.error('Attack blocked to maintain game integrity');
        return; // Abort the attack
    }
    
    // Safety check: prevent attacking your own cards
    if (defender.owner === attacker.owner) {
        console.warn('Attempted friendly fire prevented:', attacker, 'trying to attack', defender);
        return;
    }
    
    // Automatically face up cards involved in attack
    if (attacker.faceDown) {
        attacker.faceDown = false;
        console.log(`Attacker ${attacker.value}${attacker.suit} automatically faced up for attack`);
    }
    if (defender.faceDown) {
        defender.faceDown = false;
        console.log(`Defender ${defender.value}${defender.suit} automatically faced up for attack`);
    }
    
    // Check for spade absorption
    const absorber = findSpadeAbsorber(fromRow, fromCol, toRow, toCol, defender.owner);
    const actualDefender = absorber || defender;
    
    // If there's an absorber, face it up too
    if (absorber && absorber.faceDown) {
        absorber.faceDown = false;
        console.log(`Absorber ${absorber.value}${absorber.suit} automatically faced up for absorption`);
    }
    
    // Calculate damage
    let totalAttack = attacker.attack;
    
    // Check for combined attacks (multiple cards attacking same target)
    // This is simplified - in full implementation, you'd allow selecting multiple attackers
    
    // Handle attack resolution
    if (actualDefender.suit === 'joker') {
        // Attacking leader - add 3 to captured stack but don't remove leader
        for (let i = 0; i < 3; i++) {
            gameState.players[attacker.owner].captured.push({ 
                id: `leader_capture_${Math.random()}`,
                suit: 'capture',
                value: 'CAPTURE',
                owner: actualDefender.owner
            });
        }
        
        // Track that a capture occurred this turn (leader captures count too)
        
        gameState.leaderAttackedThisTurn = true;
        
        // Show leader attack animation
        startLeaderAttackAnimation(actualDefender, [toRow, toCol]);
        
        // Leader stays on the board and doesn't counter-attack (0 attack)
        // RULE: Attacker is discarded after attacking the enemy leader
        if (attacker.suit === 'joker') {
            console.warn('Leader attacked leader - leader survives but gets exhausted (cannot be discarded)');
            // Leader survives but gets exhausted
        gameState.cardsAttackedThisTurn.add(attacker.id);
            gameState.cardsMovedThisTurn.add(attacker.id);
        } else {
            // Regular card attacking leader - discard the attacker
            gameState.players[attacker.owner].discarded.push(attacker);
            startFadeOutAnimation(attacker, [fromRow, fromCol], 'discarded');
            console.log(`Card ${attacker.suit} ${attacker.value} discarded after attacking enemy leader`);
        }
    } else {
        // Regular combat resolution
        const defenderDestroyed = totalAttack >= actualDefender.defense;
        const attackerDestroyed = actualDefender.attack >= attacker.defense;
        
        if (defenderDestroyed) {
            // Defender is captured - goes to attacker's captured stack (SAFETY: Never capture leaders!)
            if (protectLeaderFromRemoval(actualDefender, "single attack capture")) {
                gameState.players[attacker.owner].captured.push(actualDefender);
            } else {
                // Leader cannot be captured, abort the capture
                console.warn('Leader capture blocked - leaders are immortal!');
                return;
            }
            
            // Track that a capture occurred this turn
            
            // Remove defender from board (SAFETY: Never remove leaders!)
            if (actualDefender.suit === 'joker') {
                console.error('CRITICAL ERROR: Attempted to remove leader from board! This should never happen!');
                return; // Abort the attack to prevent leader removal
            }
            
            if (absorber) {
                // Spade absorbed the attack - remove the spade instead of the original target
                const absorberPos = findCardPosition(actualDefender);
                if (absorber.suit === 'joker') {
                    console.error('CRITICAL ERROR: Attempted to remove absorbing leader! This should never happen!');
                    return;
                }
                startFadeOutAnimation(actualDefender, absorberPos, 'captured');
            } else {
                // No absorption - remove the original target (SAFETY: Never remove leaders!)
                if (defender.suit === 'joker') {
                    console.error('CRITICAL ERROR: Attempted to remove leader from board in single attack! This should never happen!');
                    return;
                }
                startFadeOutAnimation(defender, [toRow, toCol], 'captured');
            }
        } else {
            // Defender survives - mark as exhausted (unless it's a leader)
            if (actualDefender.suit !== 'joker') {
                gameState.cardsAttackedThisTurn.add(actualDefender.id);
                gameState.cardsMovedThisTurn.add(actualDefender.id); // Mark as exhausted
            }
        }
        
        if (attackerDestroyed) {
            // SAFETY: Never destroy leaders even in counter-attacks!
            if (attacker.suit === 'joker') {
                console.warn('Leader would be destroyed by counter-attack, but leaders are immortal!');
                // Leader survives but gets exhausted
                gameState.cardsAttackedThisTurn.add(attacker.id);
                gameState.cardsMovedThisTurn.add(attacker.id);
            } else {
                // Attacker is destroyed by counter-attack - goes to attacker's discarded stack
                gameState.players[attacker.owner].discarded.push(attacker);
                startFadeOutAnimation(attacker, [fromRow, fromCol], 'discarded');
            }
        } else {
            // Attacker survives - mark as exhausted
            gameState.cardsAttackedThisTurn.add(attacker.id);
            gameState.cardsMovedThisTurn.add(attacker.id); // Mark as exhausted
        }
    }
    
    // No need for rotation - exhaustion is tracked by action sets
    
    // Mark card as attacked
    gameState.cardsAttackedThisTurn.add(attacker.id);
    
    // Mark all involved cards (attacker and defender) as exhausted for 3 turns total
    // They will be exhausted until turn: current turn + 2
    const exhaustionEndTurn = gameState.turn + 2;
    gameState.cardsAttackExhaustion.set(attacker.id, exhaustionEndTurn);
    if (actualDefender && actualDefender.suit !== 'joker') {
        gameState.cardsAttackExhaustion.set(actualDefender.id, exhaustionEndTurn);
    }
    
    // Update drag overlays after attack (cards may have been destroyed)
    updateBoardCardOverlays();
    
    // SAFETY: Validate leaders are still on map after single attack
    if (gameState.phase === 'play') {
        validateLeadersOnMap();
    }
    
    // Check win condition
    if (gameState.players[attacker.owner].captured.length >= 10) {
        gameState.phase = 'end';
        updateScreenWakeLock(); // Release wake lock when game ends
        showPlayerWinCaption(attacker.owner);
        setTimeout(() => {
            alert(`Player ${attacker.owner} wins!`);
        }, 1000);
    }
}

function findSpadeAbsorber(attackerRow, attackerCol, targetRow, targetCol, defenderOwner) {
    // Check if any spades belonging to the defender can absorb this attack
    // Spades can absorb if they are adjacent to the attacker or in the attack path
    
    // First check spades adjacent to the attacker
    const attackerNeighbors = getHexNeighbors(attackerRow, attackerCol);
    for (const [nr, nc] of attackerNeighbors) {
        const card = gameState.board[nr][nc];
        // Face down spades and exhausted spades cannot absorb attacks
        if (card && card.suit === 'spades' && card.owner === defenderOwner && !isCardExhausted(card) && !card.faceDown) {
            return card;
        }
    }
    
    // For ranged attacks (distance > 1), also check spades in the attack path
    const distance = getDistance(attackerRow, attackerCol, targetRow, targetCol);
    if (distance > 1) {
        // Check intermediate positions in the attack path
        const dx = targetCol - attackerCol;
        const dy = targetRow - attackerRow;
        
        for (let i = 1; i < distance; i++) {
            const checkRow = attackerRow + Math.round((dy * i) / distance);
            const checkCol = attackerCol + Math.round((dx * i) / distance);
            
            // Check neighbors of this path position for spades
            const pathNeighbors = getHexNeighbors(checkRow, checkCol);
            for (const [nr, nc] of pathNeighbors) {
                const card = gameState.board[nr][nc];
                // Face down spades and exhausted spades cannot absorb attacks
                if (card && card.suit === 'spades' && card.owner === defenderOwner && !isCardExhausted(card) && !card.faceDown) {
                    return card;
                }
            }
        }
    }
    
    return null;
}

function findCardPosition(card) {
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            if (gameState.board[r][c] && gameState.board[r][c].id === card.id) {
                return [r, c];
            }
        }
    }
    return null;
}

function findLeaderPosition(player) {
    // First try the stored position
    const storedPos = gameState.players[player].leaderPosition;
    if (storedPos && gameState.board[storedPos[0]] && gameState.board[storedPos[0]][storedPos[1]] && 
        gameState.board[storedPos[0]][storedPos[1]].suit === 'joker' && 
        gameState.board[storedPos[0]][storedPos[1]].owner === player) {
        return storedPos;
    }
    
    // If stored position is wrong, scan the board
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.suit === 'joker' && card.owner === player) {
                // Update the stored position
                gameState.players[player].leaderPosition = [r, c];
                return [r, c];
            }
        }
    }
    
    // Leader not found on board
    gameState.players[player].leaderPosition = null;
    return null;
}

function autoSelectLeaderForSetup(player) {
    // Only auto-select for human players
    if (aiEnabled[player]) {
        console.log(`Skipping auto-select for AI Player ${player}`);
        return false;
    }
    
    // Find the leader card in the player's hand
    const playerData = gameState.players[player];
    const leaderCard = playerData.hand.find(card => card.suit === 'joker');
    
    if (leaderCard) {
        gameState.selectedCard = leaderCard;
        console.log(`Auto-selected leader for human Player ${player}`);
        updateUI();
        return true;
    } else {
        console.log(`No leader found in Player ${player}'s hand`);
        return false;
    }
}

function determineFirstPlayer() {
    // Count cards on battlefield
    let p1Cards = 0, p2Cards = 0;
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            if (gameState.board[r][c]) {
                if (gameState.board[r][c].owner === 1) p1Cards++;
                else p2Cards++;
            }
        }
    }
    
    if (p1Cards !== p2Cards) return p1Cards < p2Cards ? 1 : 2;
    
    // Check hand size
    const p1Hand = gameState.players[1].hand.length;
    const p2Hand = gameState.players[2].hand.length;
    if (p1Hand !== p2Hand) return p1Hand < p2Hand ? 1 : 2;
    
    // Check highest card position (simplified)
    return 1; // Default to player 1
}

function startNewTurn() {
    // No need for skew/rotation logic - exhaustion is tracked by action sets
    
    // Clear mobile hover state at start of new turn
    if (isMobileHovering) {
        clearMobileHover();
    }
    
    // Exit mobile multi-select mode at start of new turn
    exitMobileMultiSelectMode();
    
    // Draw to 5 cards
    const playerData = gameState.players[gameState.currentPlayer];
    while (playerData.hand.length < 5 && playerData.deck.length > 0) {
        drawCards(gameState.currentPlayer, 1);
    }
    
    // Reset turn-specific state
    gameState.cardsMovedThisTurn.clear();
    gameState.cardsAttackedThisTurn.clear();
    
    // Clean up expired attack exhaustion entries
    for (const [cardId, endTurn] of gameState.cardsAttackExhaustion.entries()) {
        if (gameState.turn > endTurn) {
            gameState.cardsAttackExhaustion.delete(cardId);
        }
    }
    
    gameState.leaderAttackedThisTurn = false;
    
    // Clear undo history at start of new turn
    gameHistory = [];
    
    // Clear AI action tracking for new turn
    const turnKey = `${gameState.currentPlayer}-${gameState.turn}`;
    aiActionCount.delete(turnKey);
    
    updateUI();
    
    // Update drag overlays for the new current player
    updateBoardCardOverlays();
    
    // Trigger AI move if current player is AI controlled
    if (aiEnabled[gameState.currentPlayer] && gameState.phase === 'play') {
        console.log(`startNewTurn: Triggering AI for player ${gameState.currentPlayer}`);
        setTimeout(() => {
            performAIMove(gameState.currentPlayer);
        }, 300); // Delay for better UX
    } else {
        console.log(`startNewTurn: NOT triggering AI. Player ${gameState.currentPlayer}, aiEnabled: ${aiEnabled[gameState.currentPlayer]}, phase: ${gameState.phase}`);
    }
}

// Toggle between Setup and Play phases
function toggleGamePhase() {
    if (gameState.phase === 'setup') {
        // Switch to Play phase
        console.log('Manual phase toggle: Setup -> Play');
        gameState.phase = 'play';
        gameState.currentPlayer = determineFirstPlayer();
        console.log(`First player determined: ${gameState.currentPlayer}, AI enabled: ${aiEnabled[gameState.currentPlayer]}`);
        updateMapRotation(); // Set map rotation for play mode
        showBattleCaption();
        setTimeout(() => {
            showPlayerTurnCaption(gameState.currentPlayer);
        }, 2500);
        startNewTurn();
        console.log('Switched to Play phase');
    } else if (gameState.phase === 'play') {
        // Switch back to Setup phase
        gameState.phase = 'setup';
        gameState.setupStep = 'place-cards';
        // Reset turn-based state
        gameState.selectedCard = null;
        gameState.selectedHex = null;
        gameState.selectedCards = [];
        gameState.validMoves = [];
        gameState.validAttacks = [];
        gameState.blockedMoves = [];
        gameState.absorptions = [];
        gameState.cardsMovedThisTurn.clear();
        gameState.cardsAttackedThisTurn.clear();
        gameState.cardsAttackExhaustion.clear();
        gameState.leaderAttackedThisTurn = false;
        showSetupCaption();
        
        // Auto-select leader for the current player if they haven't placed their leader yet
        const leaderOnBoard = findLeaderPosition(gameState.currentPlayer);
        if (!leaderOnBoard) {
            autoSelectLeaderForSetup(gameState.currentPlayer);
        }
        
        console.log('Switched to Setup phase');
    }
    
    updateUI();
    saveGameState();
    
    // Update screen wake lock based on new phase
    updateScreenWakeLock();
    
    // Close menu after phase toggle
    const menuOptions = document.getElementById('menu-options');
    if (menuOptions && !menuOptions.classList.contains('hidden')) {
        menuOptions.classList.add('hidden');
    }
}

function endTurn() {
    // Switch players in both Setup and Play modes
    gameState.currentPlayer = gameState.currentPlayer === 1 ? 2 : 1;
    
    if (gameState.phase === 'play') {
        // In Play mode: increment turn and start new turn
    gameState.turn++;
    
    // Check for no-capture win condition after turn increment
    // Increment move counter and check aggressor rule
    gameState.moveCount++;
    checkAggressorRule();
    
    // SAFETY: Validate leaders are still on map after turn
    validateLeadersOnMap();
    
    // Update map rotation for the new player's perspective
    updateMapRotation();
    
    clearSelection();
    showPlayerTurnCaption(gameState.currentPlayer);
    startNewTurn();
    
    // Trigger canvas update with potential rotation
    setTimeout(() => {
        updateCanvas();
    }, 100);
    } else if (gameState.phase === 'setup') {
        // In Setup mode: switch player and update map rotation based on AI presence
        updateMapRotation();
        
        clearSelection();
        
        // Auto-select leader for the new current player if they haven't placed their leader yet
        const leaderOnBoard = findLeaderPosition(gameState.currentPlayer);
        if (!leaderOnBoard) {
            autoSelectLeaderForSetup(gameState.currentPlayer);
        }
        
        updateCanvas();
        updateUI();
        
        // Update draggable overlays after player switch
        updateBoardCardOverlays();
        
        // Trigger AI move if current player is AI controlled in setup
        if (aiEnabled[gameState.currentPlayer]) {
            setTimeout(() => {
                performAISetupMove(gameState.currentPlayer);
            }, 300);
        }
    }
    
    // SAFETY: Validate leaders are still on map after turn end
    if (gameState.phase === 'play') {
        validateLeadersOnMap();
    }
    
    saveGameState(); // Save state after switching
}

function checkAggressorRule() {
    // Check if 100 moves have been completed
    if (gameState.moveCount >= 100) {
        // Check if game is already decided by captures
        const player1Captured = gameState.players[1].captured.length;
        const player2Captured = gameState.players[2].captured.length;
        
        if (player1Captured !== player2Captured) {
            // Game already decided by captures, no need for aggressor rule
            return false;
        }
        
        // Game reaches 100 moves without capture-based winner
        // First player (aggressor) loses
        const aggressor = gameState.firstPlayer;
        const winner = aggressor === 1 ? 2 : 1;
        const winReason = `Player ${winner} wins! First player (Player ${aggressor}) loses after 100 moves without decisive captures.`;
        
        gameState.phase = 'end';
        updateScreenWakeLock(); // Release wake lock when game ends
        console.log(`Game ended by 100-move aggressor rule. ${winReason}`);
        
        // Display win message
        showPlayerWinCaption(winner);
        setTimeout(() => {
            alert(`⚔️ AGGRESSOR RULE VICTORY!\n\n${winReason}\n\nThe game reached 100 moves without a clear winner by captures.`);
        }, 1000);
        
        return true; // Game ended
    }
    
    return false; // Game continues
}

// Functions for calculating card values removed - no longer needed for aggressor rule

// switchPlayer function removed - now handled by endTurn() for both modes


// Animation cleanup function
function clearAllFadeAnimations() {
    fadeOutElements.forEach(element => {
        if (element.parentNode) {
            element.parentNode.removeChild(element);
        }
    });
    fadeOutElements = [];
}

// UI updates
function updateCanvas() {
    // Clear canvas using logical dimensions
    const logicalWidth = canvas.logicalWidth || canvas.width;
    const logicalHeight = canvas.logicalHeight || canvas.height;
    ctx.clearRect(0, 0, logicalWidth, logicalHeight);
    
    // No canvas transformation - we'll flip coordinates directly
    
    // Draw hexagonal grid (11x11 with some top row cells removed)
    for (let row = 0; row < 11; row++) {
        for (let col = 0; col < 11; col++) {
            // Skip invalid hexes (even columns in top row)
            if (!isValidHex(row, col)) {
                continue;
            }
            
            const pos = hexToPixel(col, row);
            
            // Neutral hex colors - dark theme
            let fillColor = '#3a3a3a';  // Dark gray for all hexes
            let strokeColor = '#666';   // Gray borders
            let strokeWidth = 1;
            
            // Check hex highlighting states
            const isValidMove = gameState.validMoves.some(([r, c]) => r === row && c === col);
            const isBlockedMove = gameState.blockedMoves.some(([r, c]) => r === row && c === col);
            const isAttackTarget = gameState.validAttacks.some(([r, c]) => r === row && c === col);
            
            // Check if this hex is an absorbing spade (when hovering over its protected target)
            const isAbsorbingSpade = hoveredHex && gameState.absorptions.some(abs => 
                abs.target[0] === hoveredHex[0] && abs.target[1] === hoveredHex[1] && 
                abs.absorber && abs.absorber[0] === row && abs.absorber[1] === col);
            
            // Highlight valid moves (only if hex is empty - if there's a card, it will be highlighted instead)
            if (isValidMove && !gameState.board[row][col]) {
                // Use current player's color for move indicators
                const playerColor = gameState.currentPlayer === 1 ? '#87ceeb' : '#ffd700';
                fillColor = `${playerColor}40`; // Add transparency (25% opacity)
                strokeColor = `${playerColor}99`; // Add transparency (60% opacity)
                strokeWidth = 1;
            }
            
            // Highlight blocked moves (red tint)
            if (isBlockedMove) {
                fillColor = '#ff000030'; // Red with transparency
                strokeColor = '#ff000060'; // Red stroke with transparency
                strokeWidth = 1;
            }
            
            // Don't highlight attack target hexes - only highlight the cards themselves
            // (Attack target highlighting is handled in the card drawing section)
            
            
            // Draw hexagon
            drawHexagon(pos.x, pos.y, fillColor, strokeColor, strokeWidth);
            
            // Draw card if present
            const card = gameState.board[row][col];
            if (card) {
                // Skip drawing card if it's currently being dragged
                if (dragState.isDragging && dragState.draggedCard && dragState.draggedCard.id === card.id) {
                    // Draw a ghost outline at the original position
                    ctx.save();
                    ctx.globalAlpha = 0.3;
                    drawHexagon(pos.x, pos.y, 'rgba(200, 200, 200, 0.1)', '#999', 1);
                    ctx.restore();
                    
                    // Draw skull symbol on dragging card's original position if it would be destroyed in attack
                    if (attackPreviewResults && hoveredAttackTarget) {
                        const draggingCardWillBeDestroyed = 
                            attackPreviewResults.attackersCasualites.some(casualty => casualty.id === dragState.draggedCard.id);
                        
                        if (draggingCardWillBeDestroyed) {
                            drawSkullSymbol(pos.x, pos.y);
                        }
                    }
                } else {
                    // Check if this card is selected
                    const isSelected = gameState.selectedHex && gameState.selectedHex[0] === row && gameState.selectedHex[1] === col;
                    const isMultiSelected = gameState.selectedCards && gameState.selectedCards.some(selected => selected.position[0] === row && selected.position[1] === col);
                
                // Check if this attack target is being absorbed by a spade
                const isAbsorbed = isAttackTarget && gameState.absorptions.some(abs => 
                    abs.target[0] === row && abs.target[1] === col);
                
                // Check if we're hovering over this specific position and it's absorbed
                const isHoveredAndAbsorbed = hoveredHex && 
                    hoveredHex[0] === row && hoveredHex[1] === col && 
                    isAbsorbed;
                
                // Highlight attack targets, but not if we're hovering over an absorbed target
                const shouldHighlightAsTarget = isAttackTarget && !isHoveredAndAbsorbed;
                
                // Create a temporary card object for rendering - show face down cards as face up when selected
                const displayCard = { ...card };
                if (card.faceDown && isSelected) {
                    displayCard.faceDown = false;
                }
                
                drawCard(displayCard, pos.x, pos.y, shouldHighlightAsTarget, isSelected, isMultiSelected, isAbsorbingSpade);
                
                // Draw shield symbol only when hovering over protected targets
                // Don't show shield on the absorbing spade itself
                if (hoveredHex && hoveredHex[0] === row && hoveredHex[1] === col) {
                    const absorption = gameState.absorptions.find(abs => 
                        abs.target[0] === row && abs.target[1] === col
                    );
                    if (absorption) {
                        // Don't show shield if this card is the absorbing spade itself
                        const isAbsorberItself = absorption.absorber && 
                            absorption.absorber[0] === row && absorption.absorber[1] === col;
                        if (!isAbsorberItself) {
                            drawShieldSymbol(pos.x, pos.y);
                        }
                    }
                }
                
                // Draw overlay symbols for attack preview
                if (attackPreviewResults && hoveredAttackTarget) {
                    const willBeDestroyed = 
                        // Only the actual defender (spade or original target) will be captured
                        (attackPreviewResults.targetCaptured && 
                         attackPreviewResults.actualDefender.id === card.id) ||
                        // Attacker card will be casualties
                        attackPreviewResults.attackersCasualites.some(casualty => casualty.id === card.id);
                    
                    const isLeaderBeingAttacked = 
                        attackPreviewResults.isLeaderAttack && 
                        attackPreviewResults.actualDefender.id === card.id;
                    
                    if (willBeDestroyed) {
                        drawSkullSymbol(pos.x, pos.y);
                    } else if (isLeaderBeingAttacked) {
                        drawLeaderAttackSymbol(pos.x, pos.y);
                    }
                }
                
                // Draw X mark for cards that will be discarded during summoning
                if (draggedCard && gameState.phase === 'play') {
                    const currentPos = findCardPosition(draggedCard);
                    if (!currentPos && card.owner === gameState.currentPlayer) {
                        // Dragging from hand (summoning) and this is player's own card
                        const leaderPos = findLeaderPosition(gameState.currentPlayer);
                        if (leaderPos && !gameState.leaderAttackedThisTurn) {
                            const neighbors = getHexNeighbors(leaderPos[0], leaderPos[1]);
                            // Check if this position is adjacent to leader (valid summoning position)
                            if (neighbors.some(([r, c]) => r === row && c === col)) {
                                drawDiscardSymbol(pos.x, pos.y);
                            }
                        }
                    }
                }
                
                // Draw X mark for cards that will be discarded during mobile hand card selection
                const isDiscardable = validDiscards.some(([r, c]) => r === row && c === col);
                if (isDiscardable) {
                    drawDiscardSymbol(pos.x, pos.y);
                }
                } // Close the else block for non-dragged cards
            }
            
            // Draw blocked symbol for blocked moves when a card is selected
            if (!card && gameState.selectedCard && gameState.blockedMoves.some(([r, c]) => r === row && c === col)) {
                drawBlockedSymbol(pos.x, pos.y);
            }
            
            // Draw coordinate display on hovered hex only if not occupied and not showing blocked symbol
            if (hoveredHex && hoveredHex[0] === row && hoveredHex[1] === col && !card && 
                !(gameState.selectedCard && gameState.blockedMoves.some(([r, c]) => r === row && c === col))) {
                drawCoordinateOnGrid(pos.x, pos.y, col, row);
            }
        }
    }
    
    // Draw dragging card visual - show card following mouse/touch
    if (dragState.isDragging && dragState.draggedCard) {
        drawDraggingCard();
    }
}

/**
 * Convert a color to grayscale
 * @param {string} color - Color in hex format (e.g., '#ff0000')
 * @returns {string} Grayscale color in hex format
 */
function convertToGrayscale(color) {
    // Handle common color formats
    let r, g, b;
    
    if (color.startsWith('#')) {
        // Hex color
        const hex = color.slice(1);
        if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
        } else if (hex.length === 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
        } else {
            return color; // Invalid format, return original
        }
    } else if (color.startsWith('rgb')) {
        // RGB format
        const matches = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (matches) {
            r = parseInt(matches[1]);
            g = parseInt(matches[2]);
            b = parseInt(matches[3]);
        } else {
            return color; // Invalid format, return original
        }
    } else {
        // Named colors or other formats - return a neutral gray
        return '#888888';
    }
    
    // Calculate grayscale using luminance formula
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    
    // Convert back to hex
    const grayHex = gray.toString(16).padStart(2, '0');
    return `#${grayHex}${grayHex}${grayHex}`;
}

function drawCard(card, x, y, isAttackTarget = false, isSelected = false, isMultiSelected = false, isAbsorbingSpade = false) {
    // Set colors - player color for numbers, suit color for symbols
    let playerColor = '#ffffff'; // Default white for enemy face-down cards
    let suitColor = '#ffffff';
    const isOwnCard = card.owner === gameState.currentPlayer;
    const isHumanCard = !aiEnabled[card.owner]; // Check if card belongs to human player
    const isBothAI = aiEnabled[1] && aiEnabled[2]; // Check if both players are AI
    const isBothHuman = !aiEnabled[1] && !aiEnabled[2]; // Check if both players are human
    const isExhausted = isCardExhausted(card); // Declare this early for use in color processing
    
    // Determine face-down visibility based on game mode
    let showFaceDownCard = false;
    if (isBothHuman) {
        // Human vs Human: use old behavior (current player's cards)
        showFaceDownCard = isOwnCard;
    } else if (isBothAI) {
        // AI vs AI: show all face-down cards for human observer
        showFaceDownCard = true;
    } else {
        // Mixed Human vs AI: only show human player's face-down cards
        showFaceDownCard = isHumanCard;
    }
    
    if (!card.faceDown || (card.faceDown && showFaceDownCard)) {
        // Show colors based on face-down visibility rules
        playerColor = getPlayerColor(card);
        suitColor = getSuitColor(card.suit, card);
        
        // Convert to grayscale if card is exhausted
        if (isExhausted) {
            playerColor = convertToGrayscale(playerColor);
            suitColor = convertToGrayscale(suitColor);
        }
    }
    
    ctx.save();
    ctx.globalAlpha = 1.0; // Keep full opacity, use grayscale for exhausted cards instead
    
    // Draw hexagon border around card with player's side color (smaller than grid hex)
    let borderColor = card.faceDown ? getPlayerColor(card) : getPlayerColor(card);
    let lineWidth = 2;
    let backgroundColor = null;
    
    // Selection highlighting takes priority
    if (isSelected) {
        borderColor = '#ffffff'; // White border for single selection
        lineWidth = 3;
    } else if (isMultiSelected) {
        // Add subtle pulsing effect to multi-selected cards
        const pulseIntensity = 0.3 + 0.2 * Math.sin(Date.now() * 0.003); // Gentle pulse between 0.3 and 0.5
        borderColor = '#ffa500'; // Orange border for multi-selection (more distinct from yellow UI elements)
        lineWidth = 3;
        backgroundColor = `rgba(255, 165, 0, ${pulseIntensity})`; // Pulsing orange background for multi-selection
    } else if (isAbsorbingSpade && !card.faceDown) {
        backgroundColor = 'rgba(255, 128, 128, 0.5)'; // Light blue background for absorbing spades
        // Keep original border color
        lineWidth = 3; // Thicker border for emphasis
    } else if (isAttackTarget) {
        backgroundColor = 'rgba(255, 0, 0, 0.2)'; // More opaque red fill for attack targets (both face up and face down)
        // Keep original border color (don't change borderColor)
        lineWidth = 3; // Still use thicker border
    }
    
    const cardHexSize = hexSize * 0.8; // Make card border 80% of grid hex size
    
    // Create smaller hexagon corners
    const corners = [];
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        corners.push({
            x: x + cardHexSize * Math.cos(angle),
            y: y + cardHexSize * Math.sin(angle)
        });
    }
    
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) {
        ctx.lineTo(corners[i].x, corners[i].y);
    }
    ctx.closePath();
    
    // Fill background if needed (for both face up and face down cards)
    if (backgroundColor) {
        ctx.fillStyle = backgroundColor;
        ctx.fill();
    }
    
    // Draw border with half opacity for exhausted cards
    if (isExhausted) {
        ctx.globalAlpha = 0.5; // Half opacity for exhausted card borders
    }
    
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
    
    // Reset opacity back to full for content rendering
    if (isExhausted) {
        ctx.globalAlpha = 1.0;
    }
    
    // Add visual patterns for different card states
    if (card.faceDown && showFaceDownCard) {
        // Draw diagonal stripe pattern based on game mode visibility rules
        drawDiagonalStripes(x, y, cardHexSize, `${getPlayerColor(card)}20`); // Semi-transparent player color
    }
    
    // Draw text - show face-down cards based on game mode visibility rules
    const shouldShowCard = !card.faceDown || showFaceDownCard;
    
    if (shouldShowCard) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Apply additional opacity reduction for visible face-down cards
        if (card.faceDown && showFaceDownCard) {
            ctx.globalAlpha *= 0.5; // Further reduce opacity for face-down cards visible to observer
        }
        
        if (card.suit === 'joker') {
            ctx.fillStyle = suitColor;
            ctx.font = `bold ${Math.round(20 * zoomLevel)}px Arial`;
            ctx.fillText('♔', x, y + Math.round(2 * zoomLevel)); // King chess piece for leaders - vertically centered
        } else {
            // Draw card value in player color
            ctx.fillStyle = playerColor;
            ctx.font = `bold ${Math.round(14 * zoomLevel)}px Arial`;
            ctx.fillText(card.value, x, y - Math.round(5 * zoomLevel));
            // Draw suit symbol in suit color
            ctx.fillStyle = suitColor;
            ctx.font = `bold ${Math.round(16 * zoomLevel)}px Arial`;
            ctx.fillText(suitSymbols[card.suit], x, y + Math.round(6 * zoomLevel));
        }
    }
    
    ctx.restore();
}

/**
 * Draw diagonal stripes pattern for exhausted cards
 * @param {number} x - Center X coordinate
 * @param {number} y - Center Y coordinate  
 * @param {number} size - Hexagon size
 * @param {string} color - Stripe color
 */
function drawDiagonalStripes(x, y, size, color) {
    ctx.save();
    
    // Create hexagonal clipping path
    const corners = [];
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        corners.push({
            x: x + size * Math.cos(angle),
            y: y + size * Math.sin(angle)
        });
    }
    
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) {
        ctx.lineTo(corners[i].x, corners[i].y);
    }
    ctx.closePath();
    ctx.clip();
    
    // Draw diagonal stripes
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * zoomLevel;
    
    const stripeSpacing = 8 * zoomLevel;
    const numStripes = Math.ceil((size * 2) / stripeSpacing) + 2;
    
    for (let i = -numStripes; i <= numStripes; i++) {
        const offset = i * stripeSpacing;
        ctx.beginPath();
        ctx.moveTo(x - size + offset, y - size);
        ctx.lineTo(x + size + offset, y + size);
        ctx.stroke();
    }
    
    ctx.restore();
}

// Draw card being dragged following mouse/touch
function drawDraggingCard() {
    if (!dragState.isDragging || !dragState.draggedCard) return;
    
    // Get current mouse/touch position
    let dragX, dragY;
    
    if (lastMousePos) {
        // Use mouse position
        const coords = getCanvasCoordinates({ clientX: lastMousePos.x, clientY: lastMousePos.y });
        dragX = coords.x;
        dragY = coords.y;
    } else if (lastTouchPos) {
        // Use touch position  
        const coords = getCanvasCoordinates({ clientX: lastTouchPos.x, clientY: lastTouchPos.y });
        dragX = coords.x;
        dragY = coords.y;
    } else {
        // Fallback to drag start position
        dragX = dragState.startX;
        dragY = dragState.startY;
    }
    
    // Save current context state
    ctx.save();
    
    // Make the dragged card semi-transparent
    ctx.globalAlpha = 0.8;
    
    // Draw a hex background for the dragged card
    drawHexagon(dragX, dragY, 'rgba(100, 100, 100, 0.3)', '#fff', 2);
    
    // Draw the card on top
    const card = dragState.draggedCard;
    
    // Create display card (face down cards should show as face up when dragged)
    const displayCard = { ...card };
    if (card.faceDown) {
        displayCard.faceDown = false; // Show contents when dragging
    }
    
    drawCard(displayCard, dragX, dragY, false, true, false, false);
    
    ctx.restore();
}

function updateUI() {
    // Update current player display
    document.getElementById('current-player').textContent = `Player ${gameState.currentPlayer}`;
    document.getElementById('game-phase').textContent = gameState.phase.charAt(0).toUpperCase() + gameState.phase.slice(1);
    
    // Update turn info
    let turnInfo = '';
    if (gameState.phase === 'setup') {
        if (gameState.setupStep === 'place-cards') {
            const currentPlayer = gameState.currentPlayer;
            const cardsPlaced = gameState.setupCardsPlaced[currentPlayer];
            const hasLeader = gameState.setupLeaderPlaced[currentPlayer];
            const leaderText = hasLeader ? "✓L" : "1L";
            const regularCards = cardsPlaced - (hasLeader ? 1 : 0);
            turnInfo = `Place ${leaderText} + ${Math.max(0, 5 - regularCards)}R on map (${cardsPlaced}/6)`;
        } else if (gameState.setupStep === 'discard') {
            turnInfo = `Discard to 5 cards`;
        }
    } else if (gameState.phase === 'play') {
        turnInfo = `Turn ${gameState.turn} | Move ${gameState.moveCount}/100`;
        
        // Add aggressor rule warning
        if (gameState.moveCount >= 80) {
            const remaining = 100 - gameState.moveCount;
            const aggressor = gameState.firstPlayer;
            if (remaining > 0) {
                turnInfo += ` | ⚔️ Aggressor (P${aggressor}) loses in ${remaining} moves!`;
            } else {
                turnInfo += ` | 🏁 AGGRESSOR RULE TRIGGERED!`;
            }
        }
        
        // Add current map card counts
        const mapCounts = countCardsOnMap(gameState.currentPlayer);
        turnInfo += ` | On Map: ${mapCounts.leaderCount}L + ${mapCounts.regularCards}R (${mapCounts.totalCards}/6)`;
        
        // Add multi-selection info with enhanced visibility
        if (gameState.selectedCards && gameState.selectedCards.length > 0) {
            const totalAttack = gameState.selectedCards.reduce((sum, selected) => sum + selected.card.attack, 0);
            turnInfo += ` | 🔥 MULTI-SELECT: ${gameState.selectedCards.length} cards (${totalAttack} power) 🔥`;
        } else if (isMobileMultiSelectMode) {
            turnInfo += ` | 📱 TAP MORE CARDS FOR MULTI-SELECT`;
        }
    }
    
    const turnInfoElement = document.getElementById('turn-info');
    turnInfoElement.textContent = turnInfo;
    
    // Update AI thinking indicator
    updateAIThinkingUI();
    
    // Add visual emphasis for multi-selection
    if (gameState.selectedCards && gameState.selectedCards.length > 0) {
        turnInfoElement.style.color = '#ffa500';
        turnInfoElement.style.fontWeight = 'bold';
        turnInfoElement.style.textShadow = '0 0 8px rgba(255, 165, 0, 0.8)';
    } else {
        turnInfoElement.style.color = 'white';
        turnInfoElement.style.fontWeight = 'bold';
        turnInfoElement.style.textShadow = '2px 2px 4px rgba(0, 0, 0, 0.8)';
    }
    
    // Update current player's hand
    updateHand();
    
    // Update player stats
    updatePlayerStats();
    
    // Hide/disable undo button for AI players
    const undoBtn = document.getElementById('undo-btn');
    if (undoBtn) {
        if (aiEnabled[gameState.currentPlayer]) {
            undoBtn.style.display = 'none'; // Hide button during AI turn
        } else {
            undoBtn.style.display = 'inline-block'; // Show button for human players
        }
    }
}

function updateAIThinkingUI() {
    let aiThinkingElement = document.getElementById('ai-thinking');
    
    // Create AI thinking element if it doesn't exist
    if (!aiThinkingElement) {
        aiThinkingElement = document.createElement('div');
        aiThinkingElement.id = 'ai-thinking';
        aiThinkingElement.style.cssText = `
            position: fixed;
            top: 100px;
            left: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: #00ff00;
            padding: 10px 15px;
            border-radius: 8px;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            border: 2px solid #00ff00;
            box-shadow: 0 0 10px rgba(0, 255, 0, 0.5);
            z-index: 1000;
            min-width: 250px;
            display: none;
        `;
        document.body.appendChild(aiThinkingElement);
    }
    
    if (aiThinkingState.isThinking) {
        const dots = '.'.repeat(aiThinkingState.thinkingDots + 1);
        const progressBar = '█'.repeat(Math.floor(aiThinkingState.progress * 10 / aiThinkingState.maxProgress)) + 
                           '░'.repeat(10 - Math.floor(aiThinkingState.progress * 10 / aiThinkingState.maxProgress));
        const thinkingTime = Math.floor((Date.now() - aiThinkingState.startTime) / 100) / 10;
        
        aiThinkingElement.innerHTML = `
            <div style="color: #ffff00; font-weight: bold;">🤖 AI Player ${aiThinkingState.player} Thinking${dots}</div>
            <div style="margin: 5px 0; color: #ffffff;">${aiThinkingState.currentAction}</div>
            <div style="margin: 5px 0;">Progress: [${progressBar}] ${aiThinkingState.progress}/${aiThinkingState.maxProgress}</div>
            <div style="color: #888888; font-size: 12px;">Time: ${thinkingTime}s</div>
        `;
        aiThinkingElement.style.display = 'block';
        
        // Add pulsing animation
        const opacity = 0.7 + 0.3 * Math.sin(Date.now() / 200);
        aiThinkingElement.style.opacity = opacity;
    } else {
        aiThinkingElement.style.display = 'none';
    }
    
    // Show/hide undo button
    const undoBtn = document.getElementById('undo-btn');
    if (gameState.phase === 'play' && gameHistory.length > 0) {
        undoBtn.style.display = 'block';
    } else {
        undoBtn.style.display = 'none';
    }
    
    // Switch Player button removed - using END TURN card for both modes
    
    // Update phase toggle button text
    const phaseToggleBtn = document.getElementById('phase-toggle-btn');
    if (gameState.phase === 'setup') {
        phaseToggleBtn.textContent = 'Switch to Play';
    } else {
        phaseToggleBtn.textContent = 'Switch to Setup';
    }
    
    // Update AI button texts
    updateAllAIButtons();
    
    // Update board
    updateCanvas();
}

function updateHand() {
    const handEl = document.getElementById('hand-cards');
    handEl.innerHTML = '';
    
    const playerData = gameState.players[gameState.currentPlayer];
    
    // Add all cards in hand
    playerData.hand.forEach(card => {
        const cardEl = createCardElement(card, false);
        if (gameState.selectedCard && gameState.selectedCard.id === card.id) {
            cardEl.classList.add('selected');
        }
        handEl.appendChild(cardEl);
    });
    
    // Add End Turn action card for both Setup and Play modes
        const endTurnCard = document.createElement('div');
        endTurnCard.className = 'card end-turn-card';
        endTurnCard.style.backgroundColor = 'transparent';
        endTurnCard.style.color = '#FF6B6B';
        endTurnCard.style.display = 'flex';
        endTurnCard.style.alignItems = 'center';
        endTurnCard.style.justifyContent = 'center';
        endTurnCard.style.fontSize = '8px';
        endTurnCard.style.fontWeight = 'bold';
        endTurnCard.style.cursor = 'pointer';
        endTurnCard.style.border = '2px solid #FF6B6B';
        endTurnCard.style.borderRadius = '4px';
        endTurnCard.style.textAlign = 'center';
        endTurnCard.style.lineHeight = '1.2';
        endTurnCard.innerHTML = 'END<br>TURN';
        
        endTurnCard.addEventListener('click', (e) => {
            e.stopPropagation();
            endTurn();
        });
        
        handEl.appendChild(endTurnCard);
}

function updatePlayerStats() {
    // Update both players' stats
    for (let player = 1; player <= 2; player++) {
        const playerData = gameState.players[player];
        const enemyPlayer = player === 1 ? 2 : 1;
        const enemyData = gameState.players[enemyPlayer];
        
        // Switch captured display: show enemy's captured cards in each player's area
        document.getElementById(`p${player}-captured-count`).textContent = enemyData.captured.length;
        document.getElementById(`p${player}-discarded-count`).textContent = playerData.discarded.length;
        document.getElementById(`p${player}-deck-count`).textContent = playerData.deck.length;
    }
}

function resetGame() {
    // Clear any active fade animations
    clearAllFadeAnimations();
    
    // Reset game state
    gameState = {
        currentPlayer: 1,
        phase: 'setup',
        turn: 1,
        board: Array(11).fill().map(() => Array(11).fill(null)),
        players: {
            1: { hand: [], captured: [], discarded: [], deck: [], leader: null, leaderPosition: null },
            2: { hand: [], captured: [], discarded: [], deck: [], leader: null, leaderPosition: null }
        },
        selectedCard: null,
        selectedHex: null,
        selectedCards: [], // Multiple cards for combined attacks
        validMoves: [],
        validAttacks: [],
        blockedMoves: [],
        absorptions: [], // Track spade absorptions for visual feedback
        setupStep: 'place-cards', // Start directly with card placement
        setupCardsPlaced: { 1: 0, 2: 0 },
        setupLeaderPlaced: { 1: false, 2: false }, // Track if leader is placed
        leaderAttackedThisTurn: false,
        cardsMovedThisTurn: new Set(),
        cardsAttackedThisTurn: new Set(),
        cardsAttackExhaustion: new Map(), // Maps card.id -> turn number when attack exhaustion ends
        moveCount: 1, // Track total moves for aggressor rule
        firstPlayer: 1 // Track who had the first turn (aggressor)
    };
    
    // Clear undo history when resetting
    gameHistory = [];
    
    // Note: AI settings (aiEnabled) are preserved during "New Game"
    // They only reset to default on page reload
    
    clearSavedGame(); // Clear saved game when resetting
    initGame(true); // Preserve AI settings during New Game
    showSetupCaption();
    
    // Update wake lock for new game (will be released since phase is 'setup')
    updateScreenWakeLock();
    
    // Close menu after reset
    const menuOptions = document.getElementById('menu-options');
    if (menuOptions && !menuOptions.classList.contains('hidden')) {
        menuOptions.classList.add('hidden');
    }
}

// Initialize game on page load
document.addEventListener('DOMContentLoaded', () => {
    initGame();
});

// Clean up wake lock when page unloads
window.addEventListener('beforeunload', () => {
    releaseWakeLock();
    stopKeepAlive();
});

// Handle window resize
window.addEventListener('resize', () => {
    const canvas = document.getElementById('hex-canvas');
    const container = canvas.parentElement;
    const containerRect = container.getBoundingClientRect();
    
    // Maintain aspect ratio
    const maxWidth = Math.min(containerRect.width - 40, 800);
    const maxHeight = Math.min(containerRect.height - 40, 600);
    
    canvas.style.width = maxWidth + 'px';
    canvas.style.height = (maxHeight * 600 / 800) + 'px';
});

function toggleMenu() {
    const menuOptions = document.getElementById('menu-options');
    menuOptions.classList.toggle('hidden');
}

function handleMenuClose(e) {
    const menuOptions = document.getElementById('menu-options');
    const menuBtn = document.getElementById('menu-btn');
    const settingsMenu = document.getElementById('settings-menu');
    
    // If menu is open and click/tap is outside the settings menu area
    if (!menuOptions.classList.contains('hidden')) {
        // Handle both mouse clicks and touch events
        let target = e.target;
        
        // For touch events, we might need to handle differently
        if (e.type === 'touchend' && e.changedTouches && e.changedTouches.length > 0) {
            // Get the element at the touch point
            const touch = e.changedTouches[0];
            target = document.elementFromPoint(touch.clientX, touch.clientY);
        }
        
        if (target && !settingsMenu.contains(target)) {
            menuOptions.classList.add('hidden');
            console.log('Menu closed by tapping outside');
        }
    }
}

// Card drag handlers
function handleCardDragStart(e, card) {
    if (card.owner === gameState.currentPlayer && (gameState.phase === 'setup' || !isCardExhausted(card))) {
        // Use new unified drag system
        const rect = e.target.getBoundingClientRect();
        startHandCardDrag(card, e.clientX, e.clientY);
        
        // Legacy HTML5 drag support
        draggedCard = card;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
        
        // If dragging from hand in play phase, show valid summoning positions
        if (gameState.phase === 'play') {
            const currentPos = findCardPosition(card);
            if (!currentPos) {
                // Card is in hand, show summoning positions
                const leaderPos = findLeaderPosition(gameState.currentPlayer);
                if (leaderPos && !gameState.leaderAttackedThisTurn) {
                    const mapCounts = countCardsOnMap(gameState.currentPlayer);
                    const isAtMaxCapacity = mapCounts.leaderCount >= 1 && mapCounts.regularCards >= 5;
                    
                    if (isAtMaxCapacity) {
                        // At max capacity - only show positions with existing cards to replace
                        const neighbors = getHexNeighbors(leaderPos[0], leaderPos[1]);
                        gameState.validMoves = neighbors.filter(([r, c]) => {
                            const existingCard = gameState.board[r][c];
                            return existingCard && existingCard.owner === gameState.currentPlayer;
                        });
                    } else {
                        // Not at max - show all valid summoning positions (empty or own cards)
                        const neighbors = getHexNeighbors(leaderPos[0], leaderPos[1]);
                        gameState.validMoves = neighbors.filter(([r, c]) => {
                            const existingCard = gameState.board[r][c];
                            return !existingCard || existingCard.owner === gameState.currentPlayer;
                        });
                    }
                    updateCanvas(); // Refresh to show the valid positions
                }
            }
        }
    } else {
        e.preventDefault();
    }
}

function handleCardDragEnd(e) {
    // Clear summoning move highlights if they were shown
    if (draggedCard && gameState.phase === 'play') {
        const currentPos = findCardPosition(draggedCard);
        if (!currentPos) {
            // Was dragging from hand, clear the summoning highlights
            gameState.validMoves = [];
            updateCanvas();
        }
    }
    
    draggedCard = null;
    // Update cursor after card drag ends
    if (hoveredHex) {
        updateCursor(hoveredHex[0], hoveredHex[1]);
    } else {
        updateCursor(null, null);
    }
}

// Map drag handlers
function handleMapDragStart(e) {
    if (e.button === 0) { // Left mouse button only
        const coords = getCanvasCoordinates(e);
        const hex = pixelToHex(coords.x, coords.y);
        
        // Check if there's a card at this position that can be dragged
        if (hex && gameState.board[hex.row][hex.col]) {
            const card = gameState.board[hex.row][hex.col];
            if (card.owner === gameState.currentPlayer) {
                // Start dragging the card
                draggedCard = card;
                canvas.style.cursor = 'grabbing';
                return;
            }
        }
        
        // If no card to drag, start map dragging
        if (!draggedCard) {
            isDraggingMap = true;
            mapDragStartX = e.clientX;
            mapDragStartY = e.clientY;
            updateCursor(null, null); // This will show dragging cursor
        }
    }
}

function handleMapDrag(e) {
    if (isDraggingMap) {
        e.preventDefault();
        let deltaX = e.clientX - mapDragStartX;
        let deltaY = e.clientY - mapDragStartY;
        
        // If map is rotated, reverse the drag direction to feel natural
        if (mapRotated) {
            deltaX = -deltaX;
            deltaY = -deltaY;
        }
        
        boardOffsetX += deltaX;
        boardOffsetY += deltaY;
        
        mapDragStartX = e.clientX;
        mapDragStartY = e.clientY;
        
        updateCanvas();
    }
}

function handleMapDragEnd(e) {
    if (isDraggingMap) {
        isDraggingMap = false;
        // Update cursor based on current hover position
        if (hoveredHex) {
            updateCursor(hoveredHex[0], hoveredHex[1]);
        } else {
            updateCursor(null, null);
        }
    }
    
    if (draggedCard) {
        // Check if the mouse is over the hand area
        const handContainer = document.getElementById('player-hand');
        const handRect = handContainer.getBoundingClientRect();
        
        if (e.clientX >= handRect.left && e.clientX <= handRect.right &&
            e.clientY >= handRect.top && e.clientY <= handRect.bottom) {
            // Mouse is over hand area - return card to hand
            const currentPos = findCardPosition(draggedCard);
            if (currentPos && draggedCard.owner === gameState.currentPlayer) {
                returnCardToHand(draggedCard);
            }
        }
        
        draggedCard = null;
        canvas.style.cursor = 'pointer';
    }
}

// Map zoom handler
function handleMapZoom(e) {
    e.preventDefault(); // Prevent page scroll
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Get the world position before zoom
    const worldX = (mouseX - boardOffsetX) / hexSize;
    const worldY = (mouseY - boardOffsetY) / hexSize;
    
    // Zoom factor
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    zoomLevel *= zoomFactor;
    
    // Clamp zoom level
    zoomLevel = Math.max(0.5, Math.min(3.0, zoomLevel));
    
    // Update hex size based on zoom level
    hexSize = baseHexSize * zoomLevel;
    hexWidth = hexSize * 2;
    hexHeight = hexSize * Math.sqrt(3);
    
    // Calculate new offsets to keep the mouse position centered
    const newMouseWorldX = (mouseX - boardOffsetX) / hexSize;
    const newMouseWorldY = (mouseY - boardOffsetY) / hexSize;
    
    boardOffsetX += (newMouseWorldX - worldX) * hexSize;
    boardOffsetY += (newMouseWorldY - worldY) * hexSize;
    
    // Redraw the game
    drawGame();
}

// Touch event handlers for mobile support
let touchStartTime = 0;
let touchStartPos = null;
let lastTouchPos = null;
let lastTouchDistance = null;

function handleTouchStart(e) {
    // Check if any drag is already in progress (from hand or board cards)
    if (handMobileDragState.isDragging || mobileDragState.isDragging || handDesktopDragState.isDragging || desktopDragState.isDragging) {
        return; // Let the specific drag handlers manage the event
    }
    
    e.preventDefault(); // Prevent default touch behaviors
    
    if (e.touches.length === 1) {
        // Single touch - simulate mouse down
        const touch = e.touches[0];
        touchStartTime = Date.now();
        touchStartPos = { x: touch.clientX, y: touch.clientY };
        lastTouchPos = { x: touch.clientX, y: touch.clientY };
        
        // Create mock mouse event and use unified drag system
        const mouseEvent = new MouseEvent('mousedown', {
            clientX: touch.clientX,
            clientY: touch.clientY,
            button: 0
        });
        handleMouseDown(mouseEvent);
    } else if (e.touches.length === 2) {
        // Two finger touch - prepare for zoom/pan
        isDraggingMap = false;
        draggedCard = null;
        lastTouchDistance = getTouchDistance(e.touches[0], e.touches[1]);
    }
}

function handleTouchMove(e) {
    // Check if any drag is in progress (from hand or board cards)
    if (handMobileDragState.isDragging || mobileDragState.isDragging || handDesktopDragState.isDragging || desktopDragState.isDragging) {
        return; // Let the specific drag handlers manage the event
    }
    
    e.preventDefault(); // Prevent scrolling
    
    if (e.touches.length === 1 && lastTouchPos) {
        const touch = e.touches[0];
        
        // Create mock mouse event for move
        const mouseEvent = new MouseEvent('mousemove', {
            clientX: touch.clientX,
            clientY: touch.clientY
        });
        
        handleMouseMove(mouseEvent);
        lastTouchPos = { x: touch.clientX, y: touch.clientY };
    } else if (e.touches.length === 2) {
        // Handle pinch zoom
        const currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
        
        if (lastTouchDistance) {
            const distanceRatio = currentDistance / lastTouchDistance;
            const zoomFactor = distanceRatio > 1 ? 1.005 : 0.995;
            
            // Apply zoom
            zoomLevel *= zoomFactor;
            zoomLevel = Math.max(0.5, Math.min(3.0, zoomLevel));
            hexSize = baseHexSize * zoomLevel;
            hexWidth = hexSize * 2;
            hexHeight = hexSize * Math.sqrt(3);
            
            drawGame();
        }
        
        lastTouchDistance = currentDistance;
    }
}

function handleTouchEnd(e) {
    // Check if any drag is in progress (from hand or board cards)
    if (handMobileDragState.isDragging || mobileDragState.isDragging || handDesktopDragState.isDragging || desktopDragState.isDragging) {
        return; // Let the specific drag handlers manage the event
    }
    
    // Check if this touch should close the menu before processing other game logic
    const menuOptions = document.getElementById('menu-options');
    const settingsMenu = document.getElementById('settings-menu');
    
    if (!menuOptions.classList.contains('hidden') && e.changedTouches && e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        
        if (target && !settingsMenu.contains(target)) {
            menuOptions.classList.add('hidden');
            console.log('Menu closed by mobile tap outside');
            e.preventDefault();
            return; // Don't process as a game canvas touch
        }
    }
    
    e.preventDefault();
    
    if (e.touches.length === 0) {
        // All touches ended
        const touchDuration = Date.now() - touchStartTime;
        const touchDistance = lastTouchPos && touchStartPos ? 
            Math.sqrt(
                Math.pow(lastTouchPos.x - touchStartPos.x, 2) + 
                Math.pow(lastTouchPos.y - touchStartPos.y, 2)
            ) : 0;
        
        // If touch was short and didn't move much, treat as click
        if (touchDuration < 300 && touchDistance < 10 && touchStartPos) {
            // First check if this should be handled as mobile attack hover
            const coords = getCanvasCoordinates({ clientX: touchStartPos.x, clientY: touchStartPos.y });
            const hex = pixelToHex(coords.x, coords.y);
            
            if (hex && handleMobileTap(hex.row, hex.col)) {
                // Mobile tap was handled (hover activated), don't proceed with normal click
                return;
            }
            
            // Normal click handling
            const clickEvent = new MouseEvent('click', {
                clientX: touchStartPos.x,
                clientY: touchStartPos.y
            });
            handleCanvasClick(clickEvent);
        }
        
        // Create mock mouse up event
        if (lastTouchPos) {
            const mouseEvent = new MouseEvent('mouseup', {
                clientX: lastTouchPos.x,
                clientY: lastTouchPos.y
            });
            handleMouseUp(mouseEvent);
        }
        
        // Reset touch tracking
        touchStartTime = 0;
        touchStartPos = null;
        lastTouchPos = null;
        lastTouchDistance = null;
    }
}

function getTouchDistance(touch1, touch2) {
    return Math.sqrt(
        Math.pow(touch2.clientX - touch1.clientX, 2) + 
        Math.pow(touch2.clientY - touch1.clientY, 2)
    );
}

// Mobile attack hover functionality
function handleMobileTap(row, col) {
    // Only handle tap-to-hover during attack scenarios
    if (gameState.phase !== 'play' || !gameState.validAttacks || gameState.validAttacks.length === 0) {
        return false; // Not in attack mode, let normal click handling proceed
    }
    
    const isValidAttackTarget = gameState.validAttacks.some(([r, c]) => r === row && c === col);
    
    if (isValidAttackTarget) {
        // If tapping on a valid attack target
        if (isMobileHovering && mobileHoveredHex && 
            mobileHoveredHex[0] === row && mobileHoveredHex[1] === col) {
            // Second tap on same target - perform the attack
            clearMobileHover();
            return false; // Let normal attack handling proceed
        } else {
            // First tap - show hover preview
            setMobileHover(row, col);
            return true; // Consume the tap, don't perform action yet
        }
    } else if (isMobileHovering) {
        // Tapping elsewhere while hovering - clear hover
        clearMobileHover();
        return false; // Let normal click handling proceed
    }
    
    return false; // Not an attack scenario, let normal handling proceed
}

function setMobileHover(row, col) {
    mobileHoveredHex = [row, col];
    isMobileHovering = true;
    
    // Set the same hover state as mouse hover
    hoveredHex = [row, col];
    hoveredAttackTarget = [row, col];
    attackPreviewResults = calculateAttackResults(row, col);
    
    updateCanvas();
}

function clearMobileHover() {
    mobileHoveredHex = null;
    isMobileHovering = false;
    
    // Clear hover state
    hoveredHex = null;
    hoveredAttackTarget = null;
    attackPreviewResults = null;
    
    updateCanvas();
}

function countCardsOnMap(player) {
    let totalCards = 0;
    let leaderCount = 0;
    
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.owner === player) {
                totalCards++;
                if (card.suit === 'joker') {
                    leaderCount++;
                }
            }
        }
    }
    
    return { totalCards, leaderCount, regularCards: totalCards - leaderCount };
}

function placeCard(card, row, col) {
    console.log(`[AI DEBUG] placeCard - Card: ${card?.value}${card?.suit}, Position: [${row},${col}], Phase: ${gameState.phase}, Player: ${gameState.currentPlayer}`);
    
    // Check if the target position is valid
    if (!isValidHex(row, col)) {
        console.log('Cannot place card on invalid hex position');
        return false;
    }
    
    // Check card placement limits (both setup and play phases)
    const cardCurrentPos = findCardPosition(card);
    const isMovingOnBoard = cardCurrentPos !== null; // Card is already on board vs coming from hand
    
    if (!isMovingOnBoard) { // Only apply limits when placing from hand, not when moving on board
        const isLeader = card.suit === 'joker';
        const mapCounts = countCardsOnMap(card.owner);
        
        if (gameState.phase === 'setup') {
            // Setup phase validation (use existing setup tracking)
            const hasLeaderAlready = gameState.setupLeaderPlaced[card.owner];
            const cardsPlaced = gameState.setupCardsPlaced[card.owner];
            
            // Prevent placing more than allowed
            if (isLeader && hasLeaderAlready) {
                console.log('Cannot place more than 1 Leader');
                return false;
            }
            if (!isLeader && (cardsPlaced - (hasLeaderAlready ? 1 : 0)) >= 5) {
                console.log('Cannot place more than 5 regular cards');
                return false;
            }
            if (cardsPlaced >= 6) {
                console.log('Cannot place more than 6 total cards (1 Leader + 5 regular)');
                return false;
            }
        } else {
            // Play phase validation (use live map counting)
            const existingCard = gameState.board[row][col];
            const isReplacing = existingCard && existingCard.owner === card.owner;
            
            if (isLeader && mapCounts.leaderCount >= 1) {
                console.log('Cannot place more than 1 Leader on the map');
                return false;
            }
            if (!isLeader && mapCounts.regularCards >= 5 && !isReplacing) {
                console.log('Cannot place more than 5 regular cards on the map (can only replace existing cards)');
                return false;
            }
            if (mapCounts.totalCards >= 6 && !isReplacing) {
                console.log('Cannot place more than 6 total cards on the map (can only replace existing cards)');
                return false;
            }
        }
    }
    
    // Leader adjacency validation for play phase (summoning and replacing)
    if (gameState.phase === 'play' && !isMovingOnBoard) {
        // Find the leader position
        const leaderPos = findLeaderPosition(card.owner);
        if (!leaderPos) {
            console.log('Cannot place card: no leader on board');
            return false;
        }
        
        // Check if the placement position is adjacent to the leader
        const [leaderRow, leaderCol] = leaderPos;
        const neighbors = getHexNeighbors(leaderRow, leaderCol);
        const isAdjacentToLeader = neighbors.some(([r, c]) => r === row && c === col);
        
        if (!isAdjacentToLeader) {
            console.log(`Cannot place card: position [${row},${col}] is not adjacent to leader at [${leaderRow},${leaderCol}]`);
            return false;
        }
        
        // Check if leader has already been used this turn (one action limit)
        if (gameState.leaderAttackedThisTurn) {
            console.log('Cannot place card: leader has already been used this turn');
            return false;
        }
        
        console.log(`[AI DEBUG] Leader adjacency check passed for position [${row},${col}] adjacent to leader at [${leaderRow},${leaderCol}]`);
    }
    
    // Remove from current position if on board (moving the card)
    const currentPos = findCardPosition(card);
    if (currentPos) {
        // This is safe - we're moving the card, not destroying it
        gameState.board[currentPos[0]][currentPos[1]] = null;
    } else {
        // Remove from hand
        gameState.players[card.owner].hand = 
            gameState.players[card.owner].hand.filter(c => c.id !== card.id);
    }
    
    // Replace existing card if any
    if (gameState.board[row][col] && gameState.board[row][col].owner === card.owner) {
        const replacedCard = gameState.board[row][col];
        
        // Show replacement animation
        startReplacementAnimation(replacedCard, card, [row, col]);
        
        if (gameState.phase === 'setup') {
            // In setup phase, replaced cards go back to hand
            gameState.players[card.owner].hand.push(replacedCard);
        } else {
            // In play phase (summoning), replaced cards go to discarded pile (SAFETY: Never discard leaders!)
            if (protectLeaderFromRemoval(replacedCard, "replacement discard")) {
                gameState.players[card.owner].discarded.push(replacedCard);
            } else {
                // Leader cannot be discarded, return to hand instead
                console.warn('Leader discard blocked during replacement - returning to hand instead');
                gameState.players[card.owner].hand.push(replacedCard);
            }
        }
    }
    
    // Place the card - summoned cards are face down in play phase
    if (gameState.phase === 'play' && !currentPos) {
        // Card being summoned from hand in play phase - place face down
        card.faceDown = true;
        console.log(`Card ${card.value}${card.suit} summoned face down`);
    }
    
    gameState.board[row][col] = card;
    
    // If this is a leader being placed, update the leader position and leader tracking
    if (card.suit === 'joker') {
        gameState.players[card.owner].leaderPosition = [row, col];
        if (gameState.phase === 'setup') {
            gameState.setupLeaderPlaced[card.owner] = true;
        }
    }
    
    if (gameState.phase === 'setup') {
        gameState.setupCardsPlaced[card.owner]++;
        
        // After placing a card in setup, check if both players have completed setup
        const player1Done = gameState.setupLeaderPlaced[1] && gameState.setupCardsPlaced[1] >= 6;
        const player2Done = gameState.setupLeaderPlaced[2] && gameState.setupCardsPlaced[2] >= 6;
        
        if (player1Done && player2Done) {
            // Both players finished setup, start Play mode immediately
            gameState.phase = 'play';
            gameState.currentPlayer = determineFirstPlayer();
            updateMapRotation(); // Set map rotation for play mode
            startNewTurn();
        } else {
            // Update drag overlays for setup phase card placement
            updateBoardCardOverlays();
            // Auto end turn after card placement in setup
            endTurn();
        }
    } else if (gameState.phase === 'play' && !isMovingOnBoard) {
        // Mark leader as used for this turn (one action limit)
        gameState.leaderAttackedThisTurn = true;
        console.log(`[AI DEBUG] Leader marked as used this turn for card placement at [${row},${col}]`);
        
        // Update drag overlays so newly summoned cards can be dragged immediately
        updateBoardCardOverlays();
        
        // Auto-select the summoned card to show available actions (only for human players)
        if (card.owner === gameState.currentPlayer && !aiEnabled[gameState.currentPlayer]) {
            setTimeout(() => {
                // Check if the card has any available actions
                const hasAttacks = !gameState.cardsAttackedThisTurn.has(card.id) && getValidAttacks(card, row, col).length > 0;
                const hasMovement = !gameState.cardsMovedThisTurn.has(card.id) && getValidMoves(card, row, col).length > 0;
                
                if (hasAttacks || hasMovement) {
                    selectCard(card, row, col);
                    console.log(`Auto-selected ${card.value}${card.suit} after summoning (${hasAttacks ? 'attacks' : ''}${hasAttacks && hasMovement ? ' and ' : ''}${hasMovement ? 'movement' : ''} available)`);
                } else {
                    console.log(`Skipped auto-selection of ${card.value}${card.suit} - no remaining actions`);
                }
            }, 150); // Slightly longer delay to ensure canvas and overlays are updated
        }
    }
    
    return true; // Card placed successfully
}

// SAFETY VALIDATION: Ensure both leaders are always on the map
// COMPREHENSIVE LEADER PROTECTION SYSTEM
function protectLeaderFromRemoval(card, removalContext = "unknown") {
    if (card && card.suit === 'joker') {
        console.error(`CRITICAL PROTECTION: Blocked attempt to remove leader in context: ${removalContext}`);
        console.error('Leader details:', card);
        console.error('Stack trace:', new Error().stack);
        return false; // Block the removal
    }
    return true; // Allow removal of non-leaders
}

function ensureLeaderImmortality() {
    // Check if any leaders are in captured or discarded stacks and restore them
    for (let player = 1; player <= 2; player++) {
        const playerData = gameState.players[player];
        
        // Check captured stack for leaders (they should never be there)
        for (let i = playerData.captured.length - 1; i >= 0; i--) {
            const card = playerData.captured[i];
            if (card && card.suit === 'joker') {
                console.error(`EMERGENCY RESTORE: Found leader in captured stack! Restoring...`);
                playerData.captured.splice(i, 1);
                
                // Find empty spot to restore leader to board
                let restored = false;
                for (let r = 0; r < 11 && !restored; r++) {
                    for (let c = 0; c < 11 && !restored; c++) {
                        if (isValidHex(r, c) && !gameState.board[r][c]) {
                            gameState.board[r][c] = card;
                            restored = true;
                            console.log(`Leader restored to position (${r},${c})`);
                        }
                    }
                }
            }
        }
        
        // Check discarded stack for leaders (they should never be there)
        for (let i = playerData.discarded.length - 1; i >= 0; i--) {
            const card = playerData.discarded[i];
            if (card && card.suit === 'joker') {
                console.error(`EMERGENCY RESTORE: Found leader in discarded stack! Restoring...`);
                playerData.discarded.splice(i, 1);
                
                // Find empty spot to restore leader to board
                let restored = false;
                for (let r = 0; r < 11 && !restored; r++) {
                    for (let c = 0; c < 11 && !restored; c++) {
                        if (isValidHex(r, c) && !gameState.board[r][c]) {
                            gameState.board[r][c] = card;
                            restored = true;
                            console.log(`Leader restored to position (${r},${c})`);
                        }
                    }
                }
            }
        }
    }
}

function validateLeadersOnMap() {
    // First, ensure leaders are immortal and restore any that were incorrectly removed
    ensureLeaderImmortality();
    
    let leader1Found = false;
    let leader2Found = false;
    
    for (let r = 0; r < 11; r++) {
        for (let c = 0; c < 11; c++) {
            const card = gameState.board[r][c];
            if (card && card.suit === 'joker') {
                if (card.owner === 1) leader1Found = true;
                if (card.owner === 2) leader2Found = true;
            }
        }
    }
    
    if (!leader1Found) {
        console.error('CRITICAL ERROR: Player 1 leader missing from the map!');
        console.error('Current board state:', gameState.board);
        return false;
    }
    
    if (!leader2Found) {
        console.error('CRITICAL ERROR: Player 2 leader missing from the map!');
        console.error('Current board state:', gameState.board);
        return false;
    }
    
    return true;
}

function findCardById(cardId) {
    for (let r = 0; r < 11; r++) { // Updated for 11 rows
        for (let c = 0; c < 11; c++) {
            if (gameState.board[r][c] && gameState.board[r][c].id === cardId) {
                return gameState.board[r][c];
            }
        }
    }
    return null;
}

// Convert column index to letter (0=A, 1=B, 2=C, etc.)
function colToLetter(col) {
    if (col === null || col === undefined) return '';
    return String.fromCharCode(65 + col); // 65 is ASCII for 'A'
}

// Convert row index to number (0=1, 1=2, 2=3, etc.)
function rowToNumber(row) {
    if (row === null || row === undefined) return '';
    return (row + 1).toString();
}

// Draw coordinate display directly on the grid
function drawCoordinateOnGrid(x, y, col, row) {
    const letter = colToLetter(col);
    const number = rowToNumber(row);
    const coordinate = `${letter}${number}`;
    
    ctx.save();
    
    // Draw just the text with grey color, centered in hex
    ctx.font = `bold ${Math.round(12 * zoomLevel)}px Arial`;
    ctx.fillStyle = 'rgba(128, 128, 128, 0.7)'; // Grey text with some opacity
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(coordinate, x, y);
    
    ctx.restore();
}

function drawBlockedSymbol(x, y) {
    ctx.save();
    
    // Draw blocked symbol with no color (white/gray) and half opacity
    ctx.font = `bold ${Math.round(16 * zoomLevel)}px Arial`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'; // White with half opacity
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🚫', x, y); // Blocked/no entry symbol
    
    ctx.restore();
}

function drawShieldSymbol(x, y) {
    ctx.save();
    
    // Draw shield symbol over protected targets with half opacity
    ctx.font = `bold ${Math.round(20 * zoomLevel)}px Arial`;
    ctx.fillStyle = 'rgba(135, 206, 250, 0.5)'; // Light blue with half opacity
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🛡️', x, y); // Shield symbol
    
    ctx.restore();
}

function drawSkullSymbol(x, y) {
    ctx.save();
    
    // Draw skull symbol over cards that will be destroyed
    ctx.font = `bold ${Math.round(24 * zoomLevel)}px Arial`;
    ctx.fillStyle = 'rgba(255, 0, 0, 0.8)'; // Red with high opacity
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'; // White outline
    ctx.lineWidth = 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Draw white outline
    ctx.strokeText('💀', x, y); // Skull symbol
    // Draw red fill
    ctx.fillText('💀', x, y); // Skull symbol
    
    ctx.restore();
}

function drawLeaderAttackSymbol(x, y) {
    ctx.save();
    
    // Draw "-3" symbol over leaders being attacked to show they give 3 capture tokens
    ctx.font = `bold ${Math.round(20 * zoomLevel)}px Arial`;
    ctx.fillStyle = 'rgba(255, 215, 0, 0.9)'; // Gold with high opacity
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)'; // Black outline
    ctx.lineWidth = 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Draw black outline
    ctx.strokeText('-3', x, y);
    // Draw gold fill
    ctx.fillText('-3', x, y);
    
    ctx.restore();
}

function drawDiscardSymbol(x, y) {
    ctx.save();
    
    // Draw X symbol over cards that will be discarded during summoning
    ctx.font = `bold ${Math.round(24 * zoomLevel)}px Arial`;
    ctx.fillStyle = 'rgba(255, 0, 0, 0.8)'; // Red with high opacity
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'; // White outline
    ctx.lineWidth = 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Draw white outline
    ctx.strokeText('✕', x, y); // X mark symbol
    // Draw red fill
    ctx.fillText('✕', x, y); // X mark symbol
    
    ctx.restore();
}

// Update coordinate display (now just triggers canvas redraw)
function updateCoordinateDisplay(col, row, mouseX, mouseY) {
    // The coordinate will be drawn directly on the canvas
    // This function is kept for compatibility but doesn't need to do anything
    // since the coordinate is now drawn in drawCoordinateOnGrid
}