/* eslint-disable promise/param-names */
const levenshtein = require('fast-levenshtein');
const dlevenshtein = require('damerau-levenshtein');
const jaroWankler = require('jaro-winkler');
const soundex = require('soundex-code');
const logger = require('./winston');
const config = require('./config');
const fhirWrapper = require('./fhir')();
const Fhir = require('fhir').Fhir;

const fhir = new Fhir();

module.exports = () => ({
  performMatch({
    sourceResource,
    ignoreList,
    url
  }, callback) {
    const matches = {};
    matches.entry = [];
    fhirWrapper.getResource({
        resource: 'Patient',
        count: 10,
        url,
      },
      targetResources => {
        this.getMatches({
            sourceResource,
            targetResources,
            ignoreList,
          },
          matched => {
            matches.entry = matches.entry.concat(matched.entry);
            if (targetResources.next) {
              const next = targetResources.next;
              targetResources = [];
              this.performMatch({
                  sourceResource,
                  ignoreList,
                  url: next,
                },
                matched => {
                  matches.entry = matches.entry.concat(matched.entry);
                  return callback(matches);
                }
              );
            } else {
              return callback(matches);
            }
          }
        );
      }
    );
  },
  getMatches({
    sourceResource,
    targetResources,
    ignoreList = []
  }, callback) {
    const decisionRules = config.get('rules');
    const matches = {};
    matches.entry = [];
    const promises = [];
    for (const targetResource of targetResources.entry) {
      promises.push(new Promise(resolve => {
        const ignore = ignoreList.find(ignoreId => {
          return ignoreId === targetResource.resource.id;
        });
        if (ignore) {
          return resolve();
        }
        let missMatchFound = false;
        const rulePromises = [];
        for (const ruleField in decisionRules) {
          rulePromises.push(new Promise(ruleResolve => {
            const rule = decisionRules[ruleField];
            const sourceValue = fhir.evaluate(sourceResource, rule.path);
            const targetValue = fhir.evaluate(
              targetResource.resource,
              rule.path
            );
            if (
              !sourceValue ||
              !targetValue ||
              (typeof sourceValue === 'object' &&
                !Array.isArray(sourceValue)) ||
              (typeof targetValue === 'object' &&
                !Array.isArray(targetValue))
            ) {
              if (typeof sourceValue === 'object') {
                logger.warn('Object comparison are not supported ' + JSON.stringify(sourceValue));
              }
              if (typeof targetValue === 'object') {
                logger.warn('Object comparison are not supported ' + JSON.stringify(targetValue));
              }
              missMatchFound = true;
              return ruleResolve();
            }
            const algorith = rule.algorithm;
            let isMatch;
            switch (algorith) {
              case 'exact':
                isMatch = this.exactMatcher(sourceValue, targetValue);
                if (!isMatch) {
                  missMatchFound = true;
                }
                break;
              case 'levenshtein':
                isMatch = this.levenshteinMatcher(sourceValue, targetValue, rule.threshold);
                if (!isMatch) {
                  missMatchFound = true;
                }
                break;
              case 'damerau-levenshtein':
                isMatch = this.damerauLevenshteinMatcher(sourceValue, targetValue, rule.threshold);
                if (!isMatch) {
                  missMatchFound = true;
                }
                break;
              case 'jaro-winkler':
                isMatch = this.jaroWinklerMatcher(sourceValue, targetValue, rule.threshold);
                if (!isMatch) {
                  missMatchFound = true;
                }
                break;
              case 'soundex':
                isMatch = this.soundexMatcher(sourceValue, targetValue);
                if (!isMatch) {
                  missMatchFound = true;
                }
                break;
              default:
                missMatchFound = true;
                break;
            }
            ruleResolve();
          }));
        }
        Promise.all(rulePromises)
          .then(() => {
            if (!missMatchFound) {
              matches.entry.push(targetResource);
            }
            resolve();
          })
          .catch(err => {
            resolve();
            logger.error(err);
            throw err;
          });
      }));
    }
    Promise.all(promises)
      .then(() => {
        return callback(matches);
      })
      .catch(err => {
        logger.error(err);
        throw err;
      });
  },
  /**
   *
   * @param {*} value1
   * @param {*} value2
   */
  exactMatcher(value1, value2) {
    if (!Array.isArray(value1)) {
      value1 = [value1];
    }
    if (!Array.isArray(value2)) {
      value2 = [value2];
    }
    let array1;
    let array2;
    if (value1.length <= value2.length) {
      array1 = value1;
      array2 = value2;
    } else {
      array2 = value1;
      array1 = value2;
    }
    let allMatches = true;
    for (let val1 of array1) {
      let matchFound = false;
      for (let val2 of array2) {
        val1 = val1.toLowerCase();
        val1 = cleanValue(val1);
        val2 = val2.toLowerCase();
        val2 = cleanValue(val2);
        if (val1 == val2) {
          matchFound = true;
        }
      }
      if (!matchFound) {
        allMatches = false;
      }
    }
    if (allMatches) {
      return true;
    }
    return false;
  },

  levenshteinMatcher(value1, value2, threshold) {
    if (!Array.isArray(value1)) {
      value1 = [value1];
    }
    if (!Array.isArray(value2)) {
      value2 = [value2];
    }
    let array1;
    let array2;
    if (value1.length <= value2.length) {
      array1 = value1;
      array2 = value2;
    } else {
      array2 = value1;
      array1 = value2;
    }
    let withinThreshold = true;
    for (const val1 of array1) {
      let score = false;
      for (const val2 of array2) {
        const thisScore = levenshtein.get(val1, val2);
        if (score === false || thisScore < score) {
          score = thisScore;
        }
      }
      if (score > threshold) {
        withinThreshold = false;
      }
    }
    if (withinThreshold) {
      return true;
    }
    return false;
  },

  damerauLevenshteinMatcher(value1, value2, threshold) {
    if (!Array.isArray(value1)) {
      value1 = [value1];
    }
    if (!Array.isArray(value2)) {
      value2 = [value2];
    }
    let array1;
    let array2;
    if (value1.length <= value2.length) {
      array1 = value1;
      array2 = value2;
    } else {
      array2 = value1;
      array1 = value2;
    }
    let withinThreshold = true;
    for (const val1 of array1) {
      let score = false;
      for (const val2 of array2) {
        const thisScore = dlevenshtein(val1, val2);
        if (score === false || thisScore.steps < score) {
          score = thisScore.steps;
        }
      }
      if (score > threshold) {
        withinThreshold = false;
      }
    }
    if (withinThreshold) {
      return true;
    }
    return false;
  },

  jaroWinklerMatcher(value1, value2, threshold) {
    if (!Array.isArray(value1)) {
      value1 = [value1];
    }
    if (!Array.isArray(value2)) {
      value2 = [value2];
    }
    let array1;
    let array2;
    if (value1.length <= value2.length) {
      array1 = value1;
      array2 = value2;
    } else {
      array2 = value1;
      array1 = value2;
    }
    let withinThreshold = true;
    for (const val1 of array1) {
      let score = false;
      for (const val2 of array2) {
        const thisScore = jaroWankler(val1, val2);
        if (score === false || thisScore > score) {
          score = thisScore;
        }
      }
      if (score < threshold) {
        withinThreshold = false;
      }
    }
    if (withinThreshold) {
      return true;
    }
    return false;
  },

  soundexMatcher(value1, value2) {
    if (!Array.isArray(value1)) {
      value1 = [value1];
    }
    if (!Array.isArray(value2)) {
      value2 = [value2];
    }
    let array1;
    let array2;
    if (value1.length <= value2.length) {
      array1 = value1;
      array2 = value2;
    } else {
      array2 = value1;
      array1 = value2;
    }
    let allMatches = true;
    for (let val1 of array1) {
      let matchFound = false;
      for (let val2 of array2) {
        val1 = val1.toLowerCase();
        val1 = cleanValue(val1);
        val2 = val2.toLowerCase();
        val2 = cleanValue(val2);
        const code1 = soundex(val1);
        const code2 = soundex(val2);
        if (code1 == code2) {
          matchFound = true;
        }
      }
      if (!matchFound) {
        allMatches = false;
      }
    }
    if (allMatches) {
      return true;
    }
    return false;
  },

  identifiersMatcher(identifiers1, identifiers2) {

  }
});

function cleanValue(value) {
  value = value.trim();
  return value;
}