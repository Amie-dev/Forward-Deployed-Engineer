import type { Movie } from '../types/movie.types.js';

/**
 * Curated movie catalog — a real streaming platform would pull from a database.
 *
 * Deliberately covers several themes so similarity comparisons are meaningful:
 *   - Space / Sci-Fi survival cluster  →  Interstellar, The Martian, Gravity, Arrival, Life, Ad Astra
 *   - Action / superhero cluster       →  Batman, Avengers, Spider-Man
 *   - Romance cluster                  →  Titanic, La La Land, Notebook
 *   - Thriller / mystery cluster       →  Inception, Shutter Island, Knives Out
 *   - Drama cluster                    →  The Shawshank Redemption, Forrest Gump
 */
export const MOVIE_CATALOG: Movie[] = [
  // ── Space / Sci-Fi Survival ──────────────────────────────────────────────
  {
    id: '1',
    title: 'Interstellar',
    description:
      'A team of explorers travel through a wormhole in space in an attempt to ensure humanity\'s survival. A former NASA pilot leads the mission, leaving behind his family to search for a new home for humankind across the galaxy.',
    genre: 'Sci-Fi',
    year: 2014,
  },
  {
    id: '2',
    title: 'The Martian',
    description:
      'An astronaut becomes stranded on Mars after his team assumes him dead and leaves without him. Using only his scientific ingenuity and the resources left behind, he must find a way to signal Earth and survive until a rescue mission can reach him.',
    genre: 'Sci-Fi',
    year: 2015,
  },
  {
    id: '3',
    title: 'Gravity',
    description:
      'Two astronauts work together to survive after an accident leaves them stranded in space. Debris destroys their shuttle, leaving them adrift with diminishing oxygen and no way to contact Earth.',
    genre: 'Sci-Fi',
    year: 2013,
  },
  {
    id: '4',
    title: 'Arrival',
    description:
      'A linguist is recruited by the military to communicate with alien spacecraft that have landed on Earth. As she deciphers the alien language she begins to experience visions that change her understanding of time itself.',
    genre: 'Sci-Fi',
    year: 2016,
  },
  {
    id: '5',
    title: 'Life',
    description:
      'A crew aboard the International Space Station discovers a rapidly-evolving life form that caused extinction on Mars and now threatens Earth. As the creature grows stronger the crew must fight to stop it from reaching home.',
    genre: 'Sci-Fi',
    year: 2017,
  },
  {
    id: '6',
    title: 'Ad Astra',
    description:
      'An astronaut travels to the outer edges of the solar system to find his missing father whose failed experiment threatens the universe. The journey forces him to confront his own demons in the vast emptiness of space.',
    genre: 'Sci-Fi',
    year: 2019,
  },
  // ── Action / Superhero ──────────────────────────────────────────────────
  {
    id: '7',
    title: 'The Dark Knight',
    description:
      'Batman raises the stakes in his war on crime by facing a criminal mastermind known as the Joker who plunges Gotham City into chaos. With the help of allies the caped crusader fights to stop the anarchic villain and protect the city.',
    genre: 'Action',
    year: 2008,
  },
  {
    id: '8',
    title: 'Avengers: Endgame',
    description:
      'After the devastating events of Infinity War the Avengers assemble once more to undo Thanos\'s actions and restore order to the universe. The remaining heroes must travel through time to collect the Infinity Stones before Thanos does.',
    genre: 'Action',
    year: 2019,
  },
  {
    id: '9',
    title: 'Spider-Man: Into the Spider-Verse',
    description:
      'Miles Morales becomes the Spider-Man of his universe and must team up with multiple versions of Peter Parker from other dimensions to stop a threat to the multiverse. An animated coming-of-age story about identity and responsibility.',
    genre: 'Action',
    year: 2018,
  },
  // ── Romance ─────────────────────────────────────────────────────────────
  {
    id: '10',
    title: 'Titanic',
    description:
      'A young aristocrat falls in love with a kind but poor artist aboard the ill-fated luxury liner Titanic. Their romance blossoms as the ship makes its maiden voyage but is threatened by class differences and ultimately by tragedy.',
    genre: 'Romance',
    year: 1997,
  },
  {
    id: '11',
    title: 'La La Land',
    description:
      'A jazz pianist and an aspiring actress fall in love while pursuing their respective dreams in Los Angeles. The film explores the bittersweet tension between ambition and love through song and dance.',
    genre: 'Romance',
    year: 2016,
  },
  {
    id: '12',
    title: 'The Notebook',
    description:
      'A poor young man falls in love with a rich young woman during the 1940s. Years later an elderly man reads a love story from a faded notebook to a fellow nursing-home resident, revealing a timeless romance.',
    genre: 'Romance',
    year: 2004,
  },
  // ── Thriller / Mystery ──────────────────────────────────────────────────
  {
    id: '13',
    title: 'Inception',
    description:
      'A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea into the mind of a CEO. He assembles a team to execute this seemingly impossible heist inside layered dream states.',
    genre: 'Thriller',
    year: 2010,
  },
  {
    id: '14',
    title: 'Shutter Island',
    description:
      'A U.S. Marshal investigates the disappearance of a patient from a hospital for the criminally insane on a remote island. As his investigation deepens he begins to question his own sanity and the nature of reality.',
    genre: 'Thriller',
    year: 2010,
  },
  {
    id: '15',
    title: 'Knives Out',
    description:
      'A brilliant detective investigates the death of a wealthy crime novelist whose dysfunctional family are all suspects. The mystery unravels through sharp wit and unexpected twists in an elegant whodunit.',
    genre: 'Thriller',
    year: 2019,
  },
  // ── Drama ────────────────────────────────────────────────────────────────
  {
    id: '16',
    title: 'The Shawshank Redemption',
    description:
      'A banker is sentenced to life in Shawshank State Penitentiary for the murders of his wife and her lover. Over the following two decades he forms a friendship with a fellow prisoner as he plans his escape.',
    genre: 'Drama',
    year: 1994,
  },
  {
    id: '17',
    title: 'Forrest Gump',
    description:
      'The extraordinary life of a simple man from Alabama who inadvertently influences major historical events in the 20th century through his unique perspective on life and unwavering love for his childhood sweetheart Jenny.',
    genre: 'Drama',
    year: 1994,
  },
  {
    id: '18',
    title: 'Good Will Hunting',
    description:
      'A janitor at MIT possesses a genius-level intellect but struggles with emotional trauma. With the help of a therapist and encouragement from professors he must decide between a life of privilege or the south Boston neighborhood he grew up in.',
    genre: 'Drama',
    year: 1997,
  },
];
