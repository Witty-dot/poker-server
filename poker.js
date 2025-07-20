function createDeck() {
  const suits = ['h', 'd', 'c', 's'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const deck = [];

  for (let suit of suits) {
    for (let value of values) {
      deck.push(value + suit);
    }
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function dealCards(deck, count) {
  return deck.splice(0, count);
}

module.exports = { createDeck, dealCards };
