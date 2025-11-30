// poker.js
// Простые утилиты для работы с колодой

function createDeck() {
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const suits = ['♠','♥','♦','♣'];
  const deck = [];

  for (const r of ranks) {
    for (const s of suits) {
      deck.push({ rank: r, suit: s });
    }
  }

  // Перемешиваем колоду (Fisher–Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function dealCards(deck, count) {
  const hand = [];
  for (let i = 0; i < count; i++) {
    const card = deck.pop();
    if (card) hand.push(card);
  }
  return hand;
}

module.exports = {
  createDeck,
  dealCards
};
