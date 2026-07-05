const mongoose = require('mongoose');

const certificateSchema = new mongoose.Schema({
  certificateNumber: { type: String, unique: true },
  invoice:    { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  puppyName:  { type: String, required: true },
  puppyBreed: { type: String, default: 'Miniature Pinscher' },
  puppyGender:{ type: String },
  puppyColor: { type: String },
  puppyDOB:   { type: Date },
  microchip:  { type: String },
  buyerName:  { type: String, required: true },
  buyerEmail: { type: String, required: true },
  buyerPhone: { type: String },
  buyerAddress:{ type: String },
  transferDate:{ type: Date, default: Date.now },
  salePrice:  { type: Number },
  signatureData: { type: String },
  status:     { type: String, enum: ['Draft','Sent'], default: 'Draft' },
  createdAt:  { type: Date, default: Date.now }
});

module.exports = mongoose.model('Certificate', certificateSchema);
