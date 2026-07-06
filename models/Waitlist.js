const mongoose = require('mongoose');

const waitlistSchema = new mongoose.Schema({
  name:   { type: String, required: true },
  email:  { type: String, required: true },
  phone:  { type: String },
  location: { type: String },
  detectedLocation: { type: String },

  preferredGender: { type: String, default: 'No preference' },
  preferredColor:  { type: String, default: 'No preference' },
  notes:  { type: String },

  depositAmount: { type: Number, default: 200 },
  status: { type: String, enum: ['Pending Deposit', 'Active', 'Matched', 'Fulfilled', 'Cancelled'], default: 'Pending Deposit' },
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Waitlist', waitlistSchema);
