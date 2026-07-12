export const CONDITIONS = ["Sunny", "Raining", "Snowing", "Churning"];

export const COURSES = [
  {
    name: "Race City",
    length: 3,
    segments: [
      { type: "straight" },
      { type: "turn", severity: 3 },
      { type: "straight" },
      { type: "chicane", severity: 4 },
      { type: "turn", severity: 2 },
      { type: "straight" },
    ],
    conditionLikelihoods: {
      Sunny: 65,
      Raining: 10,
      Snowing: 10,
      Churning: 15,
    },
  },
  {
    name: "New Torque City",
    length: 4,
    segments: [
      { type: "straight" },
      { type: "turn", severity: 4 },
      { type: "straight" },
      { type: "chicane", severity: 5 },
      { type: "straight" },
      { type: "turn", severity: 3 },
      { type: "straight" },
      { type: "chicane", severity: 4 },
    ],
    conditionLikelihoods: {
      Sunny: 20,
      Raining: 55,
      Snowing: 20,
      Churning: 5,
    },
  },
  {
    name: "Acceleton",
    length: 5,
    segments: [
      { type: "straight" },
      { type: "turn", severity: 3 },
      { type: "straight" },
      { type: "chicane", severity: 3 },
      { type: "straight" },
      { type: "straight" },
    ],
    conditionLikelihoods: {
      Sunny: 45,
      Raining: 15,
      Snowing: 30,
      Churning: 10,
    },
  },
  {
    name: "Suzuka",
    length: 2,
    segments: [
      { type: "straight" },
      { type: "turn", severity: 2 },
      { type: "chicane", severity: 4 },
      { type: "turn", severity: 3 },
      { type: "straight" },
      { type: "chicane", severity: 5 },
      { type: "turn", severity: 4 },
      { type: "chicane", severity: 3 },
    ],
    conditionLikelihoods: {
      Sunny: 55,
      Raining: 25,
      Snowing: 15,
      Churning: 5,
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
  return {
    ...course,
    straights: course.segments.filter((segment) => segment.type === "straight").length,
    turns: course.segments.filter((segment) => segment.type === "turn").length,
    chicanes: course.segments.filter((segment) => segment.type === "chicane").length,
  };
}
