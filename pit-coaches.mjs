export const SEASON_TWO_PIT_COACH_SPECIALTIES = [
  "When you Upgrade any stat of your slower car it also upgrades the durability of your faster car.",
  "If no drivers in your relay plan have a Control higher than 8, your cars' handling is treated as 2 higher.",
  "The first rookie you draft has all of their potential applied immediately. They still count as a rookie for choosing your retainers for next season.",
  "Your bridge drivers' mishaps never last longer than 1 second.",
  "For any driver with 0 potential, you can train each of their stats one extra time. Cannot exceed a stat of 10.",
  "Every time you complete a successful trade with another manager you receive 10 points and they receive 15. You can only do this once per manager.",
  "If your team ever has two drivers with Marks of The Speed God on the course at the same time, they both instantly develop Speed Madness.",
  "Compuzoids on your team can race up to 30 laps, instead of just 20.",
  "Drivers on your team whose 3 stats are all even numbers treat their car's speed as 1 higher while driving.",
  "Any driver on your team with it/its pronouns treats their car's speed as 1 higher while driving.",
  "When your drivers win an overtake attack, the defending car takes a 1 second penalty. When your drivers lose an overtake attack, they take a 1 second penalty.",
].map((description, index) => ({ key: `season-2-specialty-${index + 1}`, name: `Specialty ${index + 1}`, description }));

export function compuzoidStintLimit(specialtyKey) {
  return specialtyKey === "season-2-specialty-8" ? 30 : 20;
}
