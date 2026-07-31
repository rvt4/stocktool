'use strict';
// Compatibility wrapper. New code should import learning-engine directly.
const { buildLearningModel, applyLearnedReturnCalibration } = require('./learning-engine');
module.exports = {
  buildCalibration: buildLearningModel,
  applyCalibration: applyLearnedReturnCalibration,
  buildLearningModel,
  applyLearnedReturnCalibration,
};
