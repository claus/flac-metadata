var util = require("util");
var stream = require('stream');
var Transform = stream.Transform || require('readable-stream').Transform;

var MetaDataBlock = require("./data/MetaDataBlock");
var MetaDataBlockStreamInfo = require("./data/MetaDataBlockStreamInfo");
var MetaDataBlockVorbisComment = require("./data/MetaDataBlockVorbisComment");
var MetaDataBlockPicture = require("./data/MetaDataBlockPicture");

const STATE_IDLE = 0;
const STATE_MARKER = 1;
const STATE_MDB_HEADER = 2;
const STATE_MDB = 3;
const STATE_PASS_THROUGH = 4;

var state = STATE_IDLE;

var isFlac = false;

var buf;
var bufPos = 0;

var mdb;
var mdbLen = 0;
var mdbLast = false;
var mdbPush = false;
var mdbLastWritten = false;

var parseMetaDataBlocks = false;

var Processor = function (options) {
  if (!(this instanceof Processor)) return new Processor(options);
  if (options && !!options.parseMetaDataBlocks) { parseMetaDataBlocks = true; }
  Transform.call(this, options);
}

util.inherits(Processor, Transform);

// MDB types
Processor.MDB_TYPE_STREAMINFO = 0;
Processor.MDB_TYPE_PADDING = 1;
Processor.MDB_TYPE_APPLICATION = 2;
Processor.MDB_TYPE_SEEKTABLE = 3;
Processor.MDB_TYPE_VORBIS_COMMENT = 4;
Processor.MDB_TYPE_CUESHEET = 5;
Processor.MDB_TYPE_PICTURE = 6;
Processor.MDB_TYPE_INVALID = 127;

Processor.prototype._transform = function (chunk, enc, done) {
  var chunkPos = 0;
  var chunkLen = chunk.length;
  var isChunkProcessed = false;
  var _this = this;

  function safePush (minCapacity, persist, validate) {
    var slice;
    var chunkAvailable = chunkLen - chunkPos;
    var isDone = (chunkAvailable + bufPos >= minCapacity);
    validate = (typeof validate === "function") ? validate : function() { return true; };
    if (isDone) {
      // Enough data available
      if (persist) {
        // Persist the entire block so it can be parsed
        if (bufPos > 0) {
          // Part of this block's data is in backup buffer, copy rest over
          chunk.copy(buf, bufPos, chunkPos, chunkPos + minCapacity - bufPos);
          slice = buf.slice(0, minCapacity);
        } else {
          // Entire block fits in current chunk
          slice = chunk.slice(chunkPos, chunkPos + minCapacity);
        }
      } else {
        slice = chunk.slice(chunkPos, chunkPos + minCapacity - bufPos);
      }
      // Push block after validation
      validate(slice, isDone) && _this.push(slice);
      chunkPos += minCapacity - bufPos;
      bufPos = 0;
      buf = null;
    } else {
      // Not enough data available
      if (persist) {
        // Copy/append incomplete block to backup buffer
        buf = buf || new Buffer(minCapacity);
        chunk.copy(buf, bufPos, chunkPos, chunkLen);
      } else {
        // Push incomplete block after validation
        slice = chunk.slice(chunkPos, chunkLen);
        validate(slice, isDone) && _this.push(slice);
      }
      bufPos += chunkLen - chunkPos;
    }
    return isDone;
  }

  while (!isChunkProcessed) {
    switch (state) {
      case STATE_IDLE:
        state = STATE_MARKER;
        break;
      case STATE_MARKER:
        if (safePush(4, true, this._validateMarker.bind(this))) {
          state = isFlac ? STATE_MDB_HEADER : STATE_PASS_THROUGH;
        } else {
          isChunkProcessed = true;
        }
        break;
      case STATE_MDB_HEADER:
        if (safePush(4, true, this._validateMDBHeader.bind(this))) {
          state = STATE_MDB;
        } else {
          isChunkProcessed = true;
        }
        break;
      case STATE_MDB:
        if (safePush(mdbLen, parseMetaDataBlocks, this._validateMDB.bind(this))) {
          if (mdb.isLast) {
            // This MDB has the isLast flag set to true.
            // Ignore all following MDBs.
            mdbLastWritten = true;
          }
          this.emit("postprocess", mdb);
          state = mdbLast ? STATE_PASS_THROUGH : STATE_MDB_HEADER;
        } else {
          isChunkProcessed = true;
        }
        break;
      case STATE_PASS_THROUGH:
        safePush(chunkLen - chunkPos, false);
        isChunkProcessed = true;
        break;
    }
  }

  done();
}

Processor.prototype._validateMarker = function(slice, isDone) {
  isFlac = (slice.toString("utf8", 0) === "fLaC");
  // TODO: completely bail out if file is not a FLAC?
  return true;
}

Processor.prototype._validateMDBHeader = function(slice, isDone) {
  // Parse MDB header
  var header = slice.readUInt32BE(0);
  var type = (header >>> 24) & 0x7f;
  mdbLast = (((header >>> 24) & 0x80) !== 0);
  mdbLen = header & 0xffffff;

  // Create appropriate MDB object
  // (data is injected later in _validateMDB, if parseMetaDataBlocks option is set to true)
  switch (type) {
    case Processor.MDB_TYPE_STREAMINFO:
      mdb = new MetaDataBlockStreamInfo(mdbLast);
      break;
    case Processor.MDB_TYPE_VORBIS_COMMENT:
      mdb = new MetaDataBlockVorbisComment(mdbLast);
      break;
    case Processor.MDB_TYPE_PICTURE:
      mdb = new MetaDataBlockPicture(mdbLast);
      break;
    case Processor.MDB_TYPE_PADDING:
    case Processor.MDB_TYPE_APPLICATION:
    case Processor.MDB_TYPE_SEEKTABLE:
    case Processor.MDB_TYPE_CUESHEET:
    case Processor.MDB_TYPE_INVALID:
    default:
      mdb = new MetaDataBlock(mdbLast, type);
      break
  }

  this.emit("preprocess", mdb);

  if (mdbLastWritten) {
    // A previous MDB had the isLast flag set to true.
    // Ignore all following MDBs.
    mdb.remove();
  } else {
    // The consumer may change the MDB's isLast flag in the preprocess handler.
    // Here that flag is updated in the MDB header.
    if (mdbLast !== mdb.isLast) {
      if (mdb.isLast) {
        header |= 0x80000000;
      } else {
        header &= 0x7fffffff;
      }
      slice.writeUInt32BE(header >>> 0, 0);
    }
  }
  mdbPush = !mdb.removed;
  return mdbPush;
}

Processor.prototype._validateMDB = function(slice, isDone) {
  // Parse the MDB if parseMetaDataBlocks option is set to true
  if (parseMetaDataBlocks && isDone) {
    mdb.parse(slice);
  }
  return mdbPush;
}

Processor.prototype._flush = function(done) {
  // All chunks have been processed
  // Clean up
  state = STATE_IDLE;
  mdbLastWritten = false;
  isFlac = false;
  bufPos = 0;
  buf = null;
  mdb = null;
  done();
}

module.exports = Processor;
