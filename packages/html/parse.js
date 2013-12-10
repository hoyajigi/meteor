
HTML.Special = function (value) {
  if (! (this instanceof HTML.Special))
    // called without `new`
    return new HTML.Special(value);

  this.value = value;
};
HTML.Special.prototype.toJS = function (options) {
  var newOptions = {};
  for (var opt in options)
    newOptions[opt] = options[opt];
  newOptions.allowAllPrimitives = true;

  return HTML.Tag.prototype.toJS.call({tagName: 'Special',
                                       attrs: this.value,
                                       children: []},
                                      newOptions);
};

parseFragment = function (input, options) {
  var scanner;
  if (typeof input === 'string')
    scanner = new Scanner(input);
  else
    // input can be a scanner.  We'd better not have a different
    // value for the "getSpecialTag" option as when the scanner
    // was created, because we don't do anything special to reset
    // the value (which is attached to the scanner).
    scanner = input;

  // ```
  // { getSpecialTag: function (scanner, templateTagPosition) {
  //     if (templateTagPosition === HTML.TEMPLATE_TAG_POSITION.ELEMENT) {
  //       ...
  // ```
  if (options && options.getSpecialTag)
    scanner.getSpecialTag = options.getSpecialTag;

  // function (scanner) -> boolean
  var shouldStop = options && options.shouldStop;

  var result = getContent(scanner, shouldStop);
  if ((! shouldStop) && (! scanner.isEOF()))
    scanner.fatal("Expected EOF");

  return result;
};

// Take a numeric Unicode code point, which may be larger than 16 bits,
// and encode it as a JavaScript UTF-16 string.
//
// Adapted from
// http://stackoverflow.com/questions/7126384/expressing-utf-16-unicode-characters-in-javascript/7126661.
codePointToString = function(cp) {
  if (cp >= 0 && cp <= 0xD7FF || cp >= 0xE000 && cp <= 0xFFFF) {
    return String.fromCharCode(cp);
  } else if (cp >= 0x10000 && cp <= 0x10FFFF) {

    // we substract 0x10000 from cp to get a 20-bit number
    // in the range 0..0xFFFF
    cp -= 0x10000;

    // we add 0xD800 to the number formed by the first 10 bits
    // to give the first byte
    var first = ((0xffc00 & cp) >> 10) + 0xD800;

    // we add 0xDC00 to the number formed by the low 10 bits
    // to give the second byte
    var second = (0x3ff & cp) + 0xDC00;

    return String.fromCharCode(first) + String.fromCharCode(second);
  } else {
    return '';
  }
};

getContent = function (scanner, shouldStopFunc) {
  var items = [];

  while (! scanner.isEOF()) {
    // Stop at any top-level end tag.  We could use the tokenizer
    // but these two characters are a giveaway.
    if (scanner.rest().slice(0, 2) === '</')
      break;

    if (shouldStopFunc && shouldStopFunc(scanner))
      break;

    var token = getHTMLToken(scanner);
    if (! token)
      // tokenizer reached EOF on its own, e.g. while scanning
      // template comments like `{{! foo}}`.
      continue;

    if (token.t === 'Doctype') {
      scanner.fatal("Unexpected Doctype");
    } else if (token.t === 'Chars') {
      pushOrAppendString(items, token.v);
    } else if (token.t === 'CharRef') {
      items.push(convertCharRef(token));
    } else if (token.t === 'Comment') {
      items.push(HTML.Comment(token.v));
    } else if (token.t === 'Special') {
      // token.v is an object `{ ... }`
      items.push(HTML.Special(token.v));
    } else if (token.t === 'Tag') {
      if (token.isEnd)
        // we've already screened for `</` so this shouldn't be
        // possible.
        scanner.fatal("Assertion failed: didn't expect end tag");

      var tagName = token.n;
      // is this an element with no close tag (a BR, HR, IMG, etc.) based
      // on its name?
      var isVoid = HTML.isVoidElement(tagName);
      if (! isVoid) {
        if (token.isSelfClosing)
          scanner.fatal('Only certain elements like BR, HR, IMG, etc. are allowed to self-close');
      }

      // may be null
      var attrs = parseAttrs(token.attrs);

      var tagFunc = HTML.getTag(tagName);
      if (isVoid) {
        items.push(attrs ? tagFunc(attrs) : tagFunc());
      } else {

        var content;
        if (token.n === 'textarea') {
          if (scanner.peek() === '\n')
            scanner.pos++;
          content = getRCData(scanner, token.n, shouldStopFunc);
        } else {
          content = getContent(scanner, shouldStopFunc);
        }

        if (scanner.rest().slice(0, 2) !== '</')
          scanner.fatal('Expected "' + tagName + '" end tag');

        var endTag = getTagToken(scanner);

        if (! (endTag.t === 'Tag' && endTag.isEnd))
          // we've already seen `</` so this shouldn't be possible
          // without erroring.
          scanner.fatal("Assertion failed: expected end tag");

        // XXX support implied end tags in cases allowed by the spec
        if (endTag.n !== tagName)
          scanner.fatal('Expected "' + tagName + '" end tag, found "' + endTag.n + '"');

        // make `content` into an array suitable for applying tag constructor
        // as in `FOO.apply(null, content)`.
        if (content == null)
          content = [];
        else if (! (content instanceof Array))
          content = [content];

        items.push(HTML.getTag(tagName).apply(
          null, (attrs ? [attrs] : []).concat(content)));
      }
    } else {
      scanner.fatal("Unknown token type: " + token.t);
    }
  }

  if (items.length === 0)
    return null;
  else if (items.length === 1)
    return items[0];
  else
    return items;
};

var pushOrAppendString = function (items, string) {
  if (items.length &&
      typeof items[items.length - 1] === 'string')
    items[items.length - 1] += string;
  else
    items.push(string);
};

// get RCDATA to go in the lowercase tagName (e.g. "textarea")
getRCData = function (scanner, tagName, shouldStopFunc) {
  var items = [];

  while (! scanner.isEOF()) {
    // break at appropriate end tag
    if (isLookingAtEndTag(scanner, tagName))
      break;

    if (shouldStopFunc && shouldStopFunc(scanner))
      break;

    if (scanner.peek() === '<') {
      pushOrAppendString(items, '<');
      scanner.pos++;
      continue;
    }

    var token = getHTMLToken(scanner);
    if (! token)
      // tokenizer reached EOF on its own, e.g. while scanning
      // template comments like `{{! foo}}`.
      continue;

    if (token.t === 'Chars') {
      pushOrAppendString(items, token.v);
    } else if (token.t === 'CharRef') {
      items.push(convertCharRef(token));
    } else if (token.t === 'Special') {
      scanner.fatal("NOT IMPLEMENTED: Can't have template tags in " + tagName);
      // token.v is an object `{ ... }`
      //items.push(HTML.Special(token.v));
    } else {
      // (can't happen)
      scanner.fatal("Unknown or unexpected token type: " + token.t);
    }
  }

  if (items.length === 0)
    return null;
  else if (items.length === 1)
    return items[0];
  else
    return items;
};

// Input: A token like `{ t: 'CharRef', v: '&amp;', cp: [38] }`.
//
// Output: A tag like `HTML.CharRef({ html: '&amp;', str: '&' })`.
var convertCharRef = function (token) {
  var codePoints = token.cp;
  var str = '';
  for (var i = 0; i < codePoints.length; i++)
    str += codePointToString(codePoints[i]);
  return HTML.CharRef({ html: token.v, str: str });
};

// Input is always a dictionary (even if zero attributes) and each
// value in the dictionary is an array of `Chars` and `CharRef`
// tokens.  An empty array means the attribute has a value of "".
//
// Output is null if there are zero attributes, and otherwise a
// dictionary.  Each value in the dictionary is a string (possibly
// empty) or an array of non-empty strings and CharRef tags.
var parseAttrs = function (attrs) {
  var result = null;

  for (var k in attrs) {
    if (! result)
      result = {};

    var inValue = attrs[k];
    var outParts = [];
    for (var i = 0; i < inValue.length; i++) {
      var token = inValue[i];
      if (token.t === 'CharRef') {
        outParts.push(convertCharRef(token));
      } else if (token.t === 'Special') {
        outParts.push(HTML.Special(token.v));
      } else if (token.t === 'Chars') {
        var str = token.v;
        var N = outParts.length;

        if (N && (typeof outParts[N - 1] === 'string'))
          outParts[N - 1] += str;
        else
          outParts.push(str);
      }
    }

    if (k === '$specials') {
      // the `$specials` pseudo-attribute should always get an
      // array, even if there is only one Special.
      result[k] = outParts;
    } else {
      var outValue = (outParts.length === 0 ? '' :
                      (outParts.length === 1 ? outParts[0] :
                       outParts));
      result[k] = outValue;
    }
  }

  return result;
};