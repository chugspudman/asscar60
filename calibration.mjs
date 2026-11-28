export const CAR_STATS = ["speed", "handling", "durability"];

export function validateCalibration(stats, totalPoints) {
  if (!stats || CAR_STATS.some((stat) => !Number.isInteger(stats[stat]) || stats[stat] < 1 || stats[stat] > 10)) {
    throw new Error("Each car stat must be a whole number between 1 and 10.");
  }
  if (CAR_STATS.reduce((sum, stat) => sum + stats[stat], 0) > totalPoints) {
    throw new Error("This car does not have enough free points.");
  }
  return Object.fromEntries(CAR_STATS.map((stat) => [stat, stats[stat]]));
}

export function calibrationPeriod({ now, season, draftComplete, firstRaceAt, racesCompleted, raceActive, easternParts, addEasternDays, easternWallTimeToDate }) {
  const closed = { open:false, period:null, closesAt:null };
  if (!draftComplete || !firstRaceAt || racesCompleted >= 20 || raceActive) return closed;
  const firstMonday = easternParts(new Date(firstRaceAt));
  for (let week = 1; week <= 4; week++) {
    const monday = addEasternDays(firstMonday, (week - 1) * 7);
    const closesAt = easternWallTimeToDate(monday, 0, 0);
    const opensAt = week === 1 ? null : easternWallTimeToDate(addEasternDays(monday, -2), 0, 0);
    if (now < closesAt && (!opensAt || now >= opensAt) && racesCompleted >= (week - 1) * 5) {
      return { open:true, period:`${season}:${week}`, week, closesAt:closesAt.toISOString() };
    }
  }
  return closed;
}
