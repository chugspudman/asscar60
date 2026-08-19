export const CONDITIONS = ["Sunny", "Raining", "Snowing", "Churning"];

export const COURSES = [
  {
    name: "Race City",
    focus: "Balance, Short",
    length: 3,
    segments: [
      { type: "turn", severity: 3 },
      { type: "chicane", severity: 3 },
      { type: "turn", severity: 3 },
    ],
    conditionLikelihoods: {
      Sunny: 70,
      Raining: 10,
      Snowing: 5,
      Churning: 15,
    },
  },
  {
    name: "New Torque City",
    focus: "Overtake, Short",
    length: 3,
    segments: [
      { type: "turn", severity: 1 },
      { type: "chicane", severity: 2 },
    ],
    conditionLikelihoods: {
      Sunny: 85,
      Raining: 5,
      Snowing: 5,
      Churning: 5,
    },
  },
  {
    name: "Acceleton",
    focus: "Balance, Long",
    length: 5,
    segments: [
      { type: "turn", severity: 3 },
      { type: "chicane", severity: 3 },
      { type: "turn", severity: 3 },
      { type: "chicane", severity: 5 },
    ],
    conditionLikelihoods: {
      Sunny: 60,
      Raining: 10,
      Snowing: 5,
      Churning: 25,
    },
  },
  {
    name: "Suzuka",
    focus: "Control, Short",
    length: 2,
    segments: [
      { type: "turn", severity: 2 },
      { type: "chicane", severity: 5 },
      { type: "chicane", severity: 5 },
      { type: "chicane", severity: 4 },
      { type: "turn", severity: 3 },
      { type: "chicane", severity: 5 },
    ],
    conditionLikelihoods: {
      Sunny: 40,
      Raining: 20,
      Snowing: 20,
      Churning: 20,
    },
  },
  {
    name: "Skidsburg",
    focus: "Control, Long",
    length: 3,
    segments: [
      { type: "chicane", severity: 5 },
      { type: "turn", severity: 5 },
      { type: "chicane", severity: 4 },
      { type: "chicane", severity: 4 },
      { type: "turn", severity: 3 },
      { type: "chicane", severity: 5 },
      { type: "turn", severity: 4 },
      { type: "turn", severity: 2 },
    ],
    conditionLikelihoods: {
      Sunny: 20,
      Raining: 30,
      Snowing: 35,
      Churning: 15,
    },
  },
  {
    name: "Velociudad",
    focus: "Overtake, Long",
    length: 6,
    segments: [
      { type: "turn", severity: 2 },
      { type: "turn", severity: 2 },
    ],
    conditionLikelihoods: {
      Sunny: 85,
      Raining: 0,
      Snowing: 0,
      Churning: 15,
    },
  },
];

export function courseByName(name) {
  return COURSES.find((course) => course.name === name) || COURSES[0];
}

export function conditionForRoll(course, roll) {
  let threshold = 0;
  for (const condition of CONDITIONS) {
    threshold += course.conditionLikelihoods[condition] / 100;
    if (roll < threshold) return condition;
  }
  return CONDITIONS.at(-1);
}

export function courseSummary(course) {
  const turns = course.segments.filter((segment) => segment.type === "turn").length;
  const chicanes = course.segments.filter((segment) => segment.type === "chicane").length;
  return {
    ...course,
    straights: "Open",
    turns,
    chicanes,
  };
}
