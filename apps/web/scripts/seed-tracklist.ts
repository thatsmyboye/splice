/**
 * Curated genre/era-diverse seed tracks for apps/web/scripts/seed-catalog.ts.
 *
 * Apple Music charts alone skew heavily toward current mainstream pop/hip-hop
 * in whatever storefronts you pull, which produces a catalog with plenty of
 * one kind of moment and almost nothing else. This list exists to fill the
 * gaps charts won't cover, so a track's real matches (jazz, classical, metal,
 * ambient, etc.) actually exist in the catalog from day one.
 *
 * Not exhaustive -- expand freely. Aim for breadth across genre/era/energy,
 * not depth within any one bucket.
 */

export interface SeedCandidate {
  title: string;
  artist: string;
  genre: string; // for logging/debugging only, not stored
}

export const CURATED_SEED_TRACKS: SeedCandidate[] = [
  // Classic jazz
  { title: "So What", artist: "Miles Davis", genre: "jazz" },
  { title: "A Love Supreme, Pt. I: Acknowledgement", artist: "John Coltrane", genre: "jazz" },
  { title: "Round Midnight", artist: "Thelonious Monk", genre: "jazz" },
  { title: "Waltz for Debby", artist: "Bill Evans", genre: "jazz" },
  { title: "Take Five", artist: "Dave Brubeck", genre: "jazz" },
  { title: "Goodbye Pork Pie Hat", artist: "Charles Mingus", genre: "jazz" },
  { title: "Cantaloupe Island", artist: "Herbie Hancock", genre: "jazz" },
  { title: "Feeling Good", artist: "Nina Simone", genre: "jazz" },
  { title: "Summertime", artist: "Ella Fitzgerald", genre: "jazz" },
  { title: "My Funny Valentine", artist: "Chet Baker", genre: "jazz" },

  // Classical
  { title: "Symphony No. 5 in C Minor", artist: "Ludwig van Beethoven", genre: "classical" },
  { title: "Clair de Lune", artist: "Claude Debussy", genre: "classical" },
  { title: "Eine kleine Nachtmusik", artist: "Wolfgang Amadeus Mozart", genre: "classical" },
  { title: "The Four Seasons: Spring", artist: "Antonio Vivaldi", genre: "classical" },
  { title: "Air on the G String", artist: "Johann Sebastian Bach", genre: "classical" },
  { title: "Nocturne in E-flat Major", artist: "Frédéric Chopin", genre: "classical" },
  { title: "Swan Lake", artist: "Pyotr Ilyich Tchaikovsky", genre: "classical" },
  { title: "Gymnopédie No. 1", artist: "Erik Satie", genre: "classical" },
  { title: "Mars, the Bringer of War", artist: "Gustav Holst", genre: "classical" },
  { title: "Adagio for Strings", artist: "Samuel Barber", genre: "classical" },

  // Ambient / electronic
  { title: "An Ending (Ascent)", artist: "Brian Eno", genre: "ambient" },
  { title: "Roygbiv", artist: "Boards of Canada", genre: "electronic" },
  { title: "Xtal", artist: "Aphex Twin", genre: "electronic" },
  { title: "A Walk", artist: "Tycho", genre: "electronic" },
  { title: "Kong", artist: "Bonobo", genre: "electronic" },
  { title: "She Moves She", artist: "Four Tet", genre: "electronic" },
  { title: "Archangel", artist: "Burial", genre: "electronic" },
  { title: "Immunity", artist: "Jon Hopkins", genre: "electronic" },
  { title: "Porcelain", artist: "Moby", genre: "electronic" },
  { title: "Autobahn", artist: "Kraftwerk", genre: "electronic" },

  // Metal
  { title: "Paranoid", artist: "Black Sabbath", genre: "metal" },
  { title: "Master of Puppets", artist: "Metallica", genre: "metal" },
  { title: "The Trooper", artist: "Iron Maiden", genre: "metal" },
  { title: "Raining Blood", artist: "Slayer", genre: "metal" },
  { title: "Cowboys from Hell", artist: "Pantera", genre: "metal" },
  { title: "Schism", artist: "Tool", genre: "metal" },
  { title: "Blood and Thunder", artist: "Mastodon", genre: "metal" },
  { title: "Ghost of Perdition", artist: "Opeth", genre: "metal" },
  { title: "Flying Whales", artist: "Gojira", genre: "metal" },
  { title: "Toxicity", artist: "System of a Down", genre: "metal" },

  // Folk / singer-songwriter
  { title: "Pink Moon", artist: "Nick Drake", genre: "folk" },
  { title: "White Winter Hymnal", artist: "Fleet Foxes", genre: "folk" },
  { title: "The Sound of Silence", artist: "Simon & Garfunkel", genre: "folk" },
  { title: "Big Yellow Taxi", artist: "Joni Mitchell", genre: "folk" },
  { title: "Skinny Love", artist: "Bon Iver", genre: "folk" },
  { title: "Flightless Bird, American Mouth", artist: "Iron & Wine", genre: "folk" },
  { title: "Ho Hey", artist: "The Lumineers", genre: "folk" },
  { title: "Chicago", artist: "Sufjan Stevens", genre: "folk" },
  { title: "Wild World", artist: "Cat Stevens", genre: "folk" },
  { title: "Diamonds & Rust", artist: "Joan Baez", genre: "folk" },

  // Hip-hop
  { title: "Alright", artist: "Kendrick Lamar", genre: "hip-hop" },
  { title: "Can I Kick It?", artist: "A Tribe Called Quest", genre: "hip-hop" },
  { title: "N.Y. State of Mind", artist: "Nas", genre: "hip-hop" },
  { title: "C.R.E.A.M.", artist: "Wu-Tang Clan", genre: "hip-hop" },
  { title: "Hey Ya!", artist: "Outkast", genre: "hip-hop" },
  { title: "Doomsday", artist: "MF DOOM", genre: "hip-hop" },
  { title: "Time: The Donut of the Heart", artist: "J Dilla", genre: "hip-hop" },
  { title: "Umi Says", artist: "Mos Def", genre: "hip-hop" },
  { title: "Runaway", artist: "Kanye West", genre: "hip-hop" },
  { title: "EARFQUAKE", artist: "Tyler, The Creator", genre: "hip-hop" },

  // R&B / soul
  { title: "What's Going On", artist: "Marvin Gaye", genre: "soul" },
  { title: "Respect", artist: "Aretha Franklin", genre: "soul" },
  { title: "Superstition", artist: "Stevie Wonder", genre: "soul" },
  { title: "Let's Stay Together", artist: "Al Green", genre: "soul" },
  { title: "(Sittin' On) The Dock of the Bay", artist: "Otis Redding", genre: "soul" },
  { title: "Untitled (How Does It Feel)", artist: "D'Angelo", genre: "r&b" },
  { title: "On & On", artist: "Erykah Badu", genre: "r&b" },
  { title: "Thinkin Bout You", artist: "Frank Ocean", genre: "r&b" },
  { title: "The Weekend", artist: "SZA", genre: "r&b" },
  { title: "Girl", artist: "The Internet", genre: "r&b" },

  // Reggae / world
  { title: "No Woman, No Cry", artist: "Bob Marley & The Wailers", genre: "reggae" },
  { title: "Chan Chan", artist: "Buena Vista Social Club", genre: "world" },
  { title: "Zombie", artist: "Fela Kuti", genre: "afrobeat" },
  { title: "Pressure Drop", artist: "Toots and the Maytals", genre: "reggae" },
  { title: "Clandestino", artist: "Manu Chao", genre: "world" },
  { title: "7 Seconds", artist: "Youssou N'Dour", genre: "world" },
  { title: "Raga Jog", artist: "Ravi Shankar", genre: "world" },
  { title: "Ai Du", artist: "Ali Farka Touré", genre: "world" },
  { title: "Sodade", artist: "Cesária Évora", genre: "world" },
  { title: "Aquele Abraço", artist: "Gilberto Gil", genre: "world" },

  // Country / Americana
  { title: "Hurt", artist: "Johnny Cash", genre: "country" },
  { title: "Jolene", artist: "Dolly Parton", genre: "country" },
  { title: "On the Road Again", artist: "Willie Nelson", genre: "country" },
  { title: "Crazy", artist: "Patsy Cline", genre: "country" },
  { title: "Boulder to Birmingham", artist: "Emmylou Harris", genre: "country" },
  { title: "Tennessee Whiskey", artist: "Chris Stapleton", genre: "country" },
  { title: "Turtles All the Way Down", artist: "Sturgill Simpson", genre: "country" },
  { title: "Slow Burn", artist: "Kacey Musgraves", genre: "country" },
  { title: "Good Hearted Woman", artist: "Waylon Jennings", genre: "country" },
  { title: "I'm So Lonesome I Could Cry", artist: "Hank Williams", genre: "country" },

  // Punk / post-punk
  { title: "London Calling", artist: "The Clash", genre: "punk" },
  { title: "Blitzkrieg Bop", artist: "Ramones", genre: "punk" },
  { title: "Anarchy in the U.K.", artist: "Sex Pistols", genre: "punk" },
  { title: "Love Will Tear Us Apart", artist: "Joy Division", genre: "post-punk" },
  { title: "Once in a Lifetime", artist: "Talking Heads", genre: "post-punk" },
  { title: "Marquee Moon", artist: "Television", genre: "post-punk" },
  { title: "Three Girl Rhumba", artist: "Wire", genre: "post-punk" },
  { title: "Waiting Room", artist: "Fugazi", genre: "punk" },
  { title: "Pay to Cum", artist: "Bad Brains", genre: "punk" },
  { title: "Holiday in Cambodia", artist: "Dead Kennedys", genre: "punk" },

  // 90s alt rock / grunge
  { title: "Smells Like Teen Spirit", artist: "Nirvana", genre: "grunge" },
  { title: "Alive", artist: "Pearl Jam", genre: "grunge" },
  { title: "Karma Police", artist: "Radiohead", genre: "alt-rock" },
  { title: "1979", artist: "The Smashing Pumpkins", genre: "alt-rock" },
  { title: "Black Hole Sun", artist: "Soundgarden", genre: "grunge" },
  { title: "Rooster", artist: "Alice in Chains", genre: "grunge" },
  { title: "Losing My Religion", artist: "R.E.M.", genre: "alt-rock" },
  { title: "Zombie", artist: "The Cranberries", genre: "alt-rock" },
  { title: "Buddy Holly", artist: "Weezer", genre: "alt-rock" },
  { title: "Loser", artist: "Beck", genre: "alt-rock" },

  // Classic rock
  { title: "Kashmir", artist: "Led Zeppelin", genre: "classic-rock" },
  { title: "Comfortably Numb", artist: "Pink Floyd", genre: "classic-rock" },
  { title: "A Day in the Life", artist: "The Beatles", genre: "classic-rock" },
  { title: "Gimme Shelter", artist: "The Rolling Stones", genre: "classic-rock" },
  { title: "Dreams", artist: "Fleetwood Mac", genre: "classic-rock" },
  { title: "Bohemian Rhapsody", artist: "Queen", genre: "classic-rock" },
  { title: "Baba O'Riley", artist: "The Who", genre: "classic-rock" },
  { title: "Fortunate Son", artist: "Creedence Clearwater Revival", genre: "classic-rock" },
  { title: "Life on Mars?", artist: "David Bowie", genre: "classic-rock" },
  { title: "Hotel California", artist: "Eagles", genre: "classic-rock" },

  // Latin
  { title: "La Vida Es Un Carnaval", artist: "Celia Cruz", genre: "latin" },
  { title: "Pedro Navaja", artist: "Rubén Blades", genre: "latin" },
  { title: "Eres", artist: "Café Tacvba", genre: "latin" },
  { title: "Ojos Así", artist: "Shakira", genre: "latin" },
  { title: "Tití Me Preguntó", artist: "Bad Bunny", genre: "reggaeton" },
  { title: "Mi Gente", artist: "J Balvin", genre: "reggaeton" },
  { title: "Malamente", artist: "Rosalía", genre: "flamenco-pop" },
  { title: "Burbujas de Amor", artist: "Juan Luis Guerra", genre: "latin" },
  { title: "Volver Volver", artist: "Vicente Fernández", genre: "ranchera" },
  { title: "Gracias a la Vida", artist: "Mercedes Sosa", genre: "latin" },

  // Afrobeat / African pop
  { title: "Ye", artist: "Burna Boy", genre: "afrobeats" },
  { title: "Essence", artist: "Wizkid", genre: "afrobeats" },
  { title: "Agolo", artist: "Angelique Kidjo", genre: "afrobeat" },
  { title: "Ja Funmi", artist: "King Sunny Adé", genre: "afrobeat" },
  { title: "Sunshine Day", artist: "Osibisa", genre: "afrobeat" },

  // K-pop / J-pop
  { title: "Dynamite", artist: "BTS", genre: "k-pop" },
  { title: "How You Like That", artist: "BLACKPINK", genre: "k-pop" },
  { title: "First Love", artist: "Hikaru Utada", genre: "j-pop" },
  { title: "Polyrhythm", artist: "Perfume", genre: "j-pop" },
  { title: "The Beginning", artist: "ONE OK ROCK", genre: "j-rock" },

  // Film / video game score
  { title: "Star Wars Main Theme", artist: "John Williams", genre: "score" },
  { title: "Time", artist: "Hans Zimmer", genre: "score" },
  { title: "Super Mario Bros. Main Theme", artist: "Koji Kondo", genre: "score" },
  { title: "One-Winged Angel", artist: "Nobuo Uematsu", genre: "score" },
  { title: "The Good, the Bad and the Ugly", artist: "Ennio Morricone", genre: "score" },
  { title: "This Is Halloween", artist: "Danny Elfman", genre: "score" },
  { title: "Blade Runner Blues", artist: "Vangelis", genre: "score" },
  { title: "Megalovania", artist: "Toby Fox", genre: "score" },
  { title: "Concerning Hobbits", artist: "Howard Shore", genre: "score" },
  { title: "Main Title", artist: "Ramin Djawadi", genre: "score" },

  // Blues
  { title: "The Thrill Is Gone", artist: "B.B. King", genre: "blues" },
  { title: "Hoochie Coochie Man", artist: "Muddy Waters", genre: "blues" },
  { title: "Cross Road Blues", artist: "Robert Johnson", genre: "blues" },
  { title: "At Last", artist: "Etta James", genre: "blues" },
  { title: "Smokestack Lightning", artist: "Howlin' Wolf", genre: "blues" },
  { title: "Pride and Joy", artist: "Stevie Ray Vaughan", genre: "blues" },
  { title: "Boom Boom", artist: "John Lee Hooker", genre: "blues" },
  { title: "Down Hearted Blues", artist: "Bessie Smith", genre: "blues" },
  { title: "Damn Right, I've Got the Blues", artist: "Buddy Guy", genre: "blues" },
  { title: "Born Under a Bad Sign", artist: "Albert King", genre: "blues" },

  // Gospel
  { title: "Precious Lord, Take My Hand", artist: "Mahalia Jackson", genre: "gospel" },
  { title: "Stomp", artist: "Kirk Franklin", genre: "gospel" },
  { title: "You Brought the Sunshine", artist: "The Clark Sisters", genre: "gospel" },
  { title: "Amazing Grace", artist: "Aretha Franklin", genre: "gospel" },
  { title: "Soon and Very Soon", artist: "Andraé Crouch", genre: "gospel" },
  { title: "Amazing Grace", artist: "The Blind Boys of Alabama", genre: "gospel" },
  { title: "Mary", artist: "Take 6", genre: "gospel" },

  // Funk / disco
  { title: "Get Up Offa That Thing", artist: "James Brown", genre: "funk" },
  { title: "Give Up the Funk (Tear the Roof off the Sucker)", artist: "Parliament", genre: "funk" },
  { title: "Thank You (Falettinme Be Mice Elf Agin)", artist: "Sly and the Family Stone", genre: "funk" },
  { title: "Le Freak", artist: "Chic", genre: "disco" },
  { title: "I Feel Love", artist: "Donna Summer", genre: "disco" },
  { title: "September", artist: "Earth, Wind & Fire", genre: "funk" },
  { title: "Stayin' Alive", artist: "Bee Gees", genre: "disco" },
  { title: "Jungle Boogie", artist: "Kool & the Gang", genre: "funk" },
  { title: "Fight the Power", artist: "The Isley Brothers", genre: "funk" },
  { title: "Super Freak", artist: "Rick James", genre: "funk" },

  // New wave / synth-pop
  { title: "Blue Monday", artist: "New Order", genre: "new-wave" },
  { title: "Enjoy the Silence", artist: "Depeche Mode", genre: "synth-pop" },
  { title: "Just Like Heaven", artist: "The Cure", genre: "new-wave" },
  { title: "Hungry Like the Wolf", artist: "Duran Duran", genre: "new-wave" },
  { title: "Everybody Wants to Rule the World", artist: "Tears for Fears", genre: "synth-pop" },
  { title: "Don't You Want Me", artist: "The Human League", genre: "synth-pop" },
  { title: "Cars", artist: "Gary Numan", genre: "synth-pop" },
  { title: "Whip It", artist: "Devo", genre: "new-wave" },
  { title: "Enola Gay", artist: "Orchestral Manoeuvres in the Dark", genre: "synth-pop" },
  { title: "Sweet Dreams (Are Made of This)", artist: "Eurythmics", genre: "synth-pop" },

  // Shoegaze / dream pop
  { title: "Only Shallow", artist: "My Bloody Valentine", genre: "shoegaze" },
  { title: "Alison", artist: "Slowdive", genre: "shoegaze" },
  { title: "Cherry-Coloured Funk", artist: "Cocteau Twins", genre: "dream-pop" },
  { title: "Vapour Trail", artist: "Ride", genre: "shoegaze" },
  { title: "Doused", artist: "DIIV", genre: "shoegaze" },
  { title: "Space Song", artist: "Beach House", genre: "dream-pop" },
  { title: "Fade Into You", artist: "Mazzy Star", genre: "dream-pop" },
  { title: "Nothing Ever Happened", artist: "Deerhunter", genre: "shoegaze" },

  // House / techno / EDM
  { title: "Your Love", artist: "Frankie Knuckles", genre: "house" },
  { title: "One More Time", artist: "Daft Punk", genre: "house" },
  { title: "Born Slippy .NUXX", artist: "Underworld", genre: "electronic" },
  { title: "Block Rockin' Beats", artist: "The Chemical Brothers", genre: "electronic" },
  { title: "The Bells", artist: "Jeff Mills", genre: "techno" },
  { title: "Latch", artist: "Disclosure", genre: "house" },
  { title: "Feel So Close", artist: "Calvin Harris", genre: "edm" },
  { title: "Don't You Worry Child", artist: "Swedish House Mafia", genre: "edm" },
  { title: "Strobe", artist: "Deadmau5", genre: "edm" },
  { title: "Scary Monsters and Nice Sprites", artist: "Skrillex", genre: "dubstep" },
  { title: "Right Here, Right Now", artist: "Fatboy Slim", genre: "electronic" },

  // Drum & bass / UK garage / grime
  { title: "Inner City Life", artist: "Goldie", genre: "drum-and-bass" },
  { title: "Horizons", artist: "LTJ Bukem", genre: "drum-and-bass" },
  { title: "Blind Faith", artist: "Chase & Status", genre: "drum-and-bass" },
  { title: "Wearing My Rolex", artist: "Wiley", genre: "grime" },
  { title: "Bonkers", artist: "Dizzee Rascal", genre: "grime" },
  { title: "Shutdown", artist: "Skepta", genre: "grime" },
  { title: "Vossi Bop", artist: "Stormzy", genre: "grime" },

  // Doom / black / death metal
  { title: "Solitude", artist: "Candlemass", genre: "doom-metal" },
  { title: "Freezing Moon", artist: "Mayhem", genre: "black-metal" },
  { title: "Symbolic", artist: "Death", genre: "death-metal" },
  { title: "Hammer Smashed Face", artist: "Cannibal Corpse", genre: "death-metal" },
  { title: "O Father O Satan O Sun!", artist: "Behemoth", genre: "black-metal" },
  { title: "Blood Fire Death", artist: "Bathory", genre: "black-metal" },
  { title: "Inno a Satana", artist: "Emperor", genre: "black-metal" },
  { title: "The Cry of Mankind", artist: "My Dying Bride", genre: "doom-metal" },

  // Bluegrass
  { title: "Blue Moon of Kentucky", artist: "Bill Monroe", genre: "bluegrass" },
  { title: "Foggy Mountain Breakdown", artist: "Flatt and Scruggs", genre: "bluegrass" },
  { title: "Down to the River to Pray", artist: "Alison Krauss", genre: "bluegrass" },
  { title: "Man of Constant Sorrow", artist: "The Stanley Brothers", genre: "bluegrass" },
  { title: "Movement and Location", artist: "Punch Brothers", genre: "bluegrass" },
  { title: "Wagon Wheel", artist: "Old Crow Medicine Show", genre: "bluegrass" },

  // Bossa nova / samba
  { title: "Chega de Saudade", artist: "João Gilberto", genre: "bossa-nova" },
  { title: "Garota de Ipanema", artist: "Antônio Carlos Jobim", genre: "bossa-nova" },
  { title: "Águas de Março", artist: "Elis Regina", genre: "bossa-nova" },
  { title: "Sozinho", artist: "Caetano Veloso", genre: "mpb" },
  { title: "Baby", artist: "Gal Costa", genre: "mpb" },
  { title: "Carolina", artist: "Seu Jorge", genre: "mpb" },
  { title: "Amor I Love You", artist: "Marisa Monte", genre: "mpb" },

  // Middle Eastern / North African
  { title: "Li Beirut", artist: "Fairuz", genre: "middle-eastern" },
  { title: "Enta Omri", artist: "Umm Kulthum", genre: "middle-eastern" },
  { title: "Didi", artist: "Cheb Khaled", genre: "raï" },
  { title: "Tamally Maak", artist: "Amr Diab", genre: "middle-eastern" },
  { title: "Mon Amie La Rose", artist: "Natacha Atlas", genre: "middle-eastern" },
  { title: "Ya Rayah", artist: "Rachid Taha", genre: "raï" },
  { title: "Raoui", artist: "Souad Massi", genre: "north-african" },

  // South Asian
  { title: "Jai Ho", artist: "A.R. Rahman", genre: "bollywood" },
  { title: "Lag Jaa Gale", artist: "Lata Mangeshkar", genre: "bollywood" },
  { title: "Allah Hoo Allah Hoo", artist: "Nusrat Fateh Ali Khan", genre: "qawwali" },
  { title: "Lover", artist: "Diljit Dosanjh", genre: "punjabi" },
  { title: "Tum Hi Ho", artist: "Arijit Singh", genre: "bollywood" },
  { title: "Prayer in Passing", artist: "Anoushka Shankar", genre: "indian-classical" },

  // Balkan / Eastern European
  { title: "Kalashnikov", artist: "Goran Bregović", genre: "balkan" },
  { title: "Asfalt Tango", artist: "Fanfare Ciocărlia", genre: "balkan" },
  { title: "Bubamara", artist: "Boban Marković Orkestar", genre: "balkan" },
  { title: "Chaje Shukarije", artist: "Esma Redžepova", genre: "balkan" },
  { title: "Balkan Brass Battle", artist: "Taraf de Haïdouks", genre: "balkan" },

  // Nordic / Scandinavian pop
  { title: "Dancing Queen", artist: "ABBA", genre: "nordic-pop" },
  { title: "Dancing On My Own", artist: "Robyn", genre: "nordic-pop" },
  { title: "The Sign", artist: "Ace of Base", genre: "nordic-pop" },
  { title: "Remind Me", artist: "Röyksopp", genre: "nordic-electronic" },
  { title: "Emmylou", artist: "First Aid Kit", genre: "nordic-folk" },
  { title: "Hoppípolla", artist: "Sigur Rós", genre: "nordic-post-rock" },

  // Minimalist / modern classical
  { title: "Metamorphosis One", artist: "Philip Glass", genre: "minimalist" },
  { title: "Music for 18 Musicians", artist: "Steve Reich", genre: "minimalist" },
  { title: "On the Nature of Daylight", artist: "Max Richter", genre: "modern-classical" },
  { title: "Near Light", artist: "Ólafur Arnalds", genre: "modern-classical" },
  { title: "Spiegel im Spiegel", artist: "Arvo Pärt", genre: "minimalist" },
  { title: "Says", artist: "Nils Frahm", genre: "modern-classical" },

  // Math rock / experimental rock
  { title: "Never Meant", artist: "American Football", genre: "math-rock" },
  { title: "Goodbye", artist: "Toe", genre: "math-rock" },
  { title: "Atlas", artist: "Battles", genre: "experimental-rock" },
  { title: "Room Full of Sparks", artist: "Don Caballero", genre: "math-rock" },
  { title: "26 Is Dancer", artist: "This Town Needs Guns", genre: "math-rock" },
  { title: "G.O.A.T.", artist: "Polyphia", genre: "math-rock" },

  // Musical theater
  { title: "Alexander Hamilton", artist: "Original Broadway Cast of Hamilton", genre: "musical-theater" },
  { title: "I Dreamed a Dream", artist: "Original London Cast of Les Misérables", genre: "musical-theater" },
  { title: "My Favorite Things", artist: "Original Broadway Cast of The Sound of Music", genre: "musical-theater" },
  { title: "Somewhere", artist: "Original Broadway Cast of West Side Story", genre: "musical-theater" },
  { title: "Defying Gravity", artist: "Idina Menzel", genre: "musical-theater" },
  { title: "My Shot", artist: "Lin-Manuel Miranda", genre: "musical-theater" },

  // Trap / modern hip-hop / drill
  { title: "Mask Off", artist: "Future", genre: "trap" },
  { title: "SICKO MODE", artist: "Travis Scott", genre: "trap" },
  { title: "Bad and Boujee", artist: "Migos", genre: "trap" },
  { title: "a lot", artist: "21 Savage", genre: "trap" },
  { title: "Dior", artist: "Pop Smoke", genre: "drill" },
  { title: "Magnolia", artist: "Playboi Carti", genre: "trap" },
  { title: "XO Tour Llif3", artist: "Lil Uzi Vert", genre: "trap" },
  { title: "Bodak Yellow", artist: "Cardi B", genre: "trap" },

  // Vaporwave / chillwave
  { title: "リサフランク420 / 現代のコンピュー", artist: "Macintosh Plus", genre: "vaporwave" },
  { title: "Feel It All Around", artist: "Washed Out", genre: "chillwave" },
  { title: "Say That", artist: "Toro y Moi", genre: "chillwave" },
  { title: "Polish Girl", artist: "Neon Indian", genre: "chillwave" },
  { title: "Teen Pregnancy", artist: "Blank Banshee", genre: "vaporwave" },
];
