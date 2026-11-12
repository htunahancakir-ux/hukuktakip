const categories = Object.freeze({
  'turnover:hukuk-reddiyat': 'Hukuk Reddiyat',
  'turnover:temlik-reddiyat': 'Temlik Reddiyat',
  'turnover:bonus': 'Bonus',
});
function categoryName(id) {
  return Object.hasOwn(categories, id) ? categories[id] : null;
}
module.exports = { categories, categoryName };
