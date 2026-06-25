const mongoose = require('mongoose');

const litterSchema = new mongoose.Schema({
  litterName: { type: String, required: true },
  birthDate: { type: Date, required: true },
  numberOfPuppies: { type: Number },
  description: { type: String },
  photos: [{ type: String }],

  // Sire (father) details
  sireName: { type: String, required: true },
  sirePhoto: { type: String },
  sireWeight: { type: String },
  sireRegistration: { type: String },
  sireAwards: { type: String },

  // Dam (mother) details
  damName: { type: String, required: true },
  damPhoto: { type: String },
  damWeight: { type: String },
  damRegistration: { type: String },
  damAwards: { type: String },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Litter', litterSchema);