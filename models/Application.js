const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema({
  applicantName: { type: String, required: true },
  email:         { type: String, required: true },
  phone:         { type: String },
  location:      { type: String },

  interestedIn:  { type: String, default: 'General / Future Litter' }, // puppy name or general

  homeOwnership: { type: String }, // Own / Rent
  landlordApproval: { type: String }, // Yes / No / N/A
  yardOrExercise: { type: String },
  otherPets:      { type: String },
  previousExperience: { type: String },
  childrenInHome: { type: String },
  primaryCaretaker: { type: String },
  whyMinPin:      { type: String },
  readyForResponsibility: { type: Boolean, default: false },

  status: { type: String, enum: ['Pending', 'Approved', 'Declined'], default: 'Pending' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Application', applicationSchema);
