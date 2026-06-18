import { generateRacerNames } from "./racer-names.mjs";

const racer = (id, pace, control, overtaking, stamina, technical, weird, potential, note) => ({
  id, pace, control, overtaking, stamina, technical, weird, potential, note,
});

export const teams = [
  {
    id: "halcyon", name: "Halcyon Comets", short: "HAL", color: "#ff4f8b",
    accent: "#ffd3e2", location: "Low Orbit, Somewhere", motto: "Arrive before causality.",
    drivers: [
      racer("vesper", 8, 7, 9, 6, 5, 8, 3, "Has never taken the same corner twice."),
      racer("mina", 6, 9, 6, 8, 7, 5, 4, "Can hear yellow flags before they happen."),
      racer("sol", 7, 6, 8, 7, 6, 9, 2, "Legally classified as a sunset."),
      racer("june", 5, 8, 5, 9, 9, 4, 5, "Repairs engines by telling them secrets."),
      racer("cass", 7, 7, 7, 7, 6, 6, 3, "A dependable impossibility."),
      racer("orin", 6, 6, 8, 5, 7, 10, 4, "Still finishing a race from last season."),
      racer("bee", 5, 9, 4, 8, 8, 7, 3, "Followed everywhere by ideal cloud cover."),
      racer("pax", 9, 4, 9, 5, 4, 6, 2, "Brakes are a strongly worded suggestion."),
    ],
  },
  {
    id: "mire", name: "Mirelight Motors", short: "MIR", color: "#8bea9d",
    accent: "#d7ffdf", location: "The Luminous Fen", motto: "Grip is a state of mind.",
    drivers: [
      racer("fen", 7, 8, 6, 8, 8, 7, 3, "Leaves bioluminescent tire marks."),
      racer("moss", 6, 9, 5, 9, 7, 8, 4, "Has an excellent relationship with mud."),
      racer("reed", 8, 6, 8, 6, 6, 5, 3, "Writes apologies to every passed car."),
      racer("sable", 7, 7, 9, 6, 5, 9, 2, "Visible only in rear-view mirrors."),
      racer("pond", 5, 8, 5, 8, 9, 6, 5, "Insists the team is all part of the pond."),
      racer("lark", 6, 7, 7, 7, 7, 7, 4, "Carries emergency frogs."),
    ],
  },
  {
    id: "brass", name: "Brass Horizon", short: "BRZ", color: "#f6b44b",
    accent: "#ffe7bc", location: "The Last Honest Desert", motto: "The sun owes us a rematch.",
    drivers: [
      racer("ida", 9, 6, 8, 7, 7, 4, 2, "Reflective in several emotional spectra."),
      racer("dust", 7, 8, 7, 9, 6, 5, 3, "Never removes the ceremonial goggles."),
      racer("arc", 8, 5, 9, 6, 5, 8, 4, "Runs brighter under pressure."),
      racer("mercy", 6, 9, 5, 8, 9, 3, 3, "Can diagnose a gearbox by its regrets."),
      racer("hot", 7, 6, 7, 7, 6, 7, 5, "Knows a shortcut that is not always there."),
      racer("noon", 6, 8, 6, 8, 7, 6, 3, "Rings once at the apex."),
    ],
  },
  {
    id: "archive", name: "Archive Racing Club", short: "ARC", color: "#9c8cff",
    accent: "#ddd7ff", location: "Restricted Stacks, Level 9", motto: "Every finish is filed.",
    drivers: [
      racer("folio", 7, 9, 6, 8, 9, 6, 3, "Cites precedent before overtaking."),
      racer("index", 8, 7, 8, 7, 8, 4, 3, "Alphabetizes the starting grid."),
      racer("errata", 6, 7, 7, 6, 6, 10, 5, "Occasionally corrects reality."),
      racer("margin", 5, 9, 5, 9, 8, 7, 4, "Small, precise, and difficult to erase."),
      racer("quill", 8, 6, 9, 6, 5, 8, 2, "Signs autographs at terminal velocity."),
      racer("due", 7, 8, 6, 8, 7, 5, 3, "Always arrives exactly too soon."),
    ],
  },
  {
    id: "choir", name: "Thunder Choir", short: "THN", color: "#43d9ff",
    accent: "#c9f6ff", location: "Weather Station Hallelujah", motto: "Louder than velocity.",
    drivers: [
      racer("alto", 8, 7, 8, 7, 6, 8, 3, "Sings in slipstreams."),
      racer("rumble", 7, 6, 9, 8, 5, 7, 4, "The helmet is mostly subwoofer."),
      racer("hush", 6, 9, 5, 9, 8, 6, 4, "The quiet before themselves."),
      racer("coda", 9, 5, 8, 6, 5, 9, 2, "Finishes every sentence with lightning."),
      racer("aria", 6, 8, 6, 8, 9, 5, 3, "Keeps the vehicle electrically humble."),
      racer("bass", 7, 7, 7, 7, 7, 7, 3, "Forecast: considerable noise."),
    ],
  },
  {
    id: "velvet", name: "Velvet Emergency", short: "VEL", color: "#ff765f",
    accent: "#ffd8d1", location: "The Red Telephone", motto: "Remain calm. Accelerate.",
    drivers: [
      racer("alarm", 8, 6, 9, 7, 5, 6, 3, "Has never entered a room normally."),
      racer("plush", 6, 9, 5, 8, 8, 8, 4, "Soft to the touch, sharp in the chicane."),
      racer("exit", 9, 5, 8, 6, 6, 7, 2, "Always knows the quickest way out."),
      racer("siren", 7, 7, 7, 8, 7, 9, 3, "Only audible to approaching trouble."),
      racer("calm", 5, 9, 5, 9, 9, 4, 5, "Nobody has managed it yet."),
      racer("urgent", 8, 6, 8, 7, 5, 8, 3, "The name is also the strategy."),
    ],
  },
];

const generatedNames = generateRacerNames(
  teams.reduce((total, team) => total + team.drivers.length, 0),
);
let generatedNameIndex = 0;
for (const team of teams) {
  for (const driver of team.drivers) {
    driver.name = generatedNames[generatedNameIndex];
    generatedNameIndex += 1;
  }
}

export function defaultLineup(team) {
  return team.drivers.slice(0, 6).map((driver) => ({
    driverId: driver.id,
    laps: 20,
  }));
}

export function defaultCarNames(team) {
  return ["Starling", "Nightjar"];
}

export function buildEntries(lineups = {}, carNames = {}, rosters = {}, cars = {}, brands = {}) {
  return teams.flatMap((team) => {
    const brand = brands[team.id] || {};
    const teamName = brand.name || team.name;
    const teamShort = brand.abbreviation || team.short;
    const teamColor = brand.color || team.color;
    const roster = rosters[team.id] || team.drivers;
    const teamCars = cars[team.id] || [];
    const selected = lineups[team.id] || defaultLineup(team);
    const selectedCarNames = carNames[team.id] || defaultCarNames(team);
    return [0, 1].map((carIndex) => {
      const assignments = [0, 1, 2].map((offset) => {
        const value = selected[carIndex * 3 + offset];
        const driverId = typeof value === "string" ? value : value?.driverId;
        const laps = typeof value === "string" ? 20 : Number(value?.laps ?? 20);
        return {
          driver: roster.find((driver) => driver.id === driverId) || roster[offset],
          laps,
        };
      });
      let nextLap = 1;
      const stints = assignments.map((assignment) => {
        const start = nextLap;
        const end = start + assignment.laps - 1;
        nextLap = end + 1;
        return { start, end, driver: assignment.driver };
      });
      return {
        id: `${team.id}-${carIndex + 1}`,
        teamId: team.id,
        teamName,
        teamShort,
        color: teamColor,
        carName: `${teamShort} ${selectedCarNames[carIndex]}`,
        vehicle: {
          speed: teamCars[carIndex]?.speed ?? 3,
          handling: teamCars[carIndex]?.handling ?? 3,
          durability: teamCars[carIndex]?.durability ?? 3,
          feedback: teamCars[carIndex]?.feedback ?? 3,
          weird: teamCars[carIndex]?.weird ?? 3,
        },
        stints,
      };
    });
  });
}
