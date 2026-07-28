export function summarizeFavoriteCandidateCoverage(workflow = {}) {
  const favoriteWords = [...new Set(
    (Array.isArray(workflow?.words) ? workflow.words : [])
      .map(word => String(word || '').trim())
      .filter(Boolean)
  )];
  const statuses = workflow?.statuses && typeof workflow.statuses === 'object'
    ? workflow.statuses
    : {};
  const candidatePool = workflow?.candidatePool && typeof workflow.candidatePool === 'object'
    ? workflow.candidatePool
    : {};
  const activeFavoriteWords = favoriteWords.filter(word => statuses[word] !== 'published');
  const publishedFavoriteWords = favoriteWords.filter(word => statuses[word] === 'published');
  const missingActiveWords = activeFavoriteWords.filter(word => !candidatePool[word]);

  return {
    totalFavorites: favoriteWords.length,
    activeFavorites: activeFavoriteWords.length,
    publishedFavorites: publishedFavoriteWords.length,
    candidateCount: Object.keys(candidatePool).length,
    missingActiveWords
  };
}
