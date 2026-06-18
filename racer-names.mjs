export const RACER_NAME_POOL = `
Aaron
Abbey
Ackers
Acland
Adcock
Adkins
Ambler
Anderson
Andrews
Appleby
Archer
Angel
Attaboy
Arcturo
Axel
Achtung
Austin
Adam
Alice
Ashley
Bagina
Bacon
Ball
Bamford
Beechum
Beaumont
Bear
Blast
Beaver
Brock
Bend
Belcher
Blythe
Borne
Bower
Bracey
Buckland
Burnoutson
Byron
Beverly
Bish
Clutch
Cable
Clark
Carly
Carcarcara
Cannon
Chuck
Crow
Chauncey
Cheese
Coombs
Chivers
Cliff
Colbeck
Compton
Cruz
Crofford
Christ
Dad
Darcy
Dane
Doyle
Driver
Dimple
Darn
Dry
Dipshit
Duckworth
Dirge
Dash
Delf
Derrick
Dexter
Erin
Eric
Erlin
Ebony
East
Egg
Egerton
Eban
Edwards
Empey
English
Fireball
Ferric
Flee
Farnsworth
Falina
Frazier
Fiona
Furman
Franklin
Fox
Flip
Fork
Gay
Ganson
Gazzard
Gus
Gil
Gabrielle
Guppy
Grant
God
Georgeson
Gladys
Grist
Goomba
Glasscock
Hammer
Haley
Hark
Ham
Harder
Hank
Horse
Hogan
Hooper
Hector
Heron
Holiday
Hood
Howl
Inez
Ingmar
Irving
Iles
Ibn
Ireland
Indigo
Ida
Ivan
Imelda
Jack
Jamison
Jorge
Jury
Jarvis
Jenkins
Jessop
John
Jubilee
Jesus
Jandy
Kane
Kier
Kendra
Kathy
Karr
Ken
Kick
Karen
Kingston
Kirkland
Kubrick
Kid
Knagg
Legs
Lick
Lil
Laird
Leonard
Lilliman
Longerbane
Lowly
Lucky
Loser
Love
Lamp
Laser
Loomis
McCloud
Major
Mars
Misty
Mitchell
Mogg
Monk
Masterson
McDingle
Milton
Moody
Moon
Moist
Mildew
Mega
Nasty
Nathan
Nancy
Newman
Nathans
NcHugh
Nixon
Nut
Nobbs
North
Niles
Orb
Ogilvy
O'Smarmy
Orson
Olivia
Otto
Ooo
October
Oxley
Outside
Okay
Pesky
Patty
Peter
Parsons
Pescadero
Plinker
Pottery
Piss
Punkband
Poodle
Prince
Pklgjv
Portly
Quaint
Quill
Quin
Quimby
Quelch
Quick
Quixote
Quarry
Qi
Race
Random
Rain
Rust
Rebecca
Ryan
Red
Rutt
Reese
Rigby
Ridley
Rogers
Rocky
Reynolds
Russell
Salmon
Sano
Matsui
Takeda
Hashimoto
Miyamoto
Yokoyama
Sakai
Kojima
Fuji
Sad
Samson
Smith
Sticky
Sally
Sam
Snark
Sorenson
Skeet
Skipper
Slade
Stackhouse
Stanley
Street
Stein
South
Talbot
Terry
Tush
Tracy
Ted
Trotter
Tubbs
Thorpe
Tibet
Trimbull
Turtle
Tank
Thatcher
Twelve
Tusk
Toronto
Usher
Upton
Ussein
Upward
Underwood
Ursula
Uli
Uggo
Umbleby
Uncle
Upstart
Undo
Uh-Oh
Victor
Viola
Vance
Valery
Verbal
Vox
Vernon
Voyle
Vicker
Wild
Weagle
Walter
Wendy
Whiskey
Wicker
Wolf
West
Wheeler
Wagon
Water
Wet
Whiskers
Wells
Winter
Weird
Wackadoo
Xander
Xylophone
Yancy
Young
Yates
Yellow
Yard
Yak
Yosemite
Yolanda
Yes
Yonder
Zigler
Zack
Zoey
Zoo
Zane
Zebulon
Zebra
Zed
`.trim().split(/\r?\n/).map((name) => name.trim()).filter(Boolean);

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateRacerNames(count, seed = 60060, reservedNames = []) {
  const random = seededRandom(seed);
  const reservedFullNames = new Set(reservedNames.map((name) => String(name).trim()));
  const usedParts = new Set(
    reservedNames.flatMap((name) => String(name).split(" ").filter(Boolean)),
  );
  const available = RACER_NAME_POOL.filter((part) => !usedParts.has(part));
  const names = [];

  for (let index = available.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [available[index], available[swapIndex]] = [available[swapIndex], available[index]];
  }

  const uniquePartCount = Math.min(count, Math.floor(available.length / 2));
  for (let index = 0; index < uniquePartCount; index += 1) {
    names.push(`${available[index * 2]} ${available[index * 2 + 1]}`);
  }

  const usedFullNames = new Set([...reservedFullNames, ...names]);
  let attempts = 0;
  while (names.length < count) {
    attempts += 1;
    if (attempts > count * RACER_NAME_POOL.length * RACER_NAME_POOL.length) {
      throw new RangeError(`Cannot generate ${count} unique racer full names.`);
    }
    const first = RACER_NAME_POOL[Math.floor(random() * RACER_NAME_POOL.length)];
    const last = RACER_NAME_POOL[Math.floor(random() * RACER_NAME_POOL.length)];
    const fullName = `${first} ${last}`;
    if (first === last || usedFullNames.has(fullName)) continue;
    names.push(fullName);
    usedFullNames.add(fullName);
  }
  return names;
}
