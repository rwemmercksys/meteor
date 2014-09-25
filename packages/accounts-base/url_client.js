// By default, allow the autologin process to happen
autoLoginEnabled = true;

// All of the special hash URLs we support for accounts interactions
var accountsPaths = ["reset-password", "verify-email", "enroll-account"];

// Separate out this functionality for testing
var attemptToMatchHash = function (hash, success) {
  _.each(accountsPaths, function (urlPart) {
    var token;
    var email;

    var tokenWithEmailRegex = new RegExp("^\\#\\/" + urlPart + "\\/(.*)/(.*)$");
    var match = hash.match(tokenWithEmailRegex);

    if (match) {
      // get the token and email from the URL
      token = match[1];
      email = match[2];
    } else {
      // XXX COMPAT WITH 0.9.3
      // This is to support urls generated with the old system that doesn't
      // include the email address in the link.
      var oldTokenRegex = new RegExp("^\\#\\/" + urlPart + "\\/(.*)$");
      match = hash.match(oldTokenRegex);

      if (match) {
        token = match[1];
        email = null; // no email in the URL
      } else {
        return;
      }
    }

    // Do some stuff with the token and email we matched
    success(token, email, urlPart);
  });
};

// We only support one callback per URL
var accountsCallbacks = {};

// The UI flow will call this when done to log in the existing person
var enableAutoLogin = function () {
  Accounts._enableAutoLogin();
};

// Actually call the function, has to happen in the top level so that we can
// mess with autoLoginEnabled.
attemptToMatchHash(window.location.hash, function (token, email, urlPart) {
  // put login in a suspended state to wait for the interaction to finish
  autoLoginEnabled = false;

  // reset the URL
  window.location.hash = "";

  // wait for other packages to register callbacks
  Meteor.startup(function () {
    // if a callback has been registered for this kind of token, call it
    if (accountsCallbacks[urlPart]) {
      accountsCallbacks[urlPart](token, email, enableAutoLogin);
    }
  });

  // XXX COMPAT WITH 0.9.3
  if (urlPart === "reset-password") {
    Accounts._resetPasswordToken = token;
  } else if (urlPart === "verify-email") {
    Accounts._verifyEmailToken = token;
  } else if (urlPart === "enroll-account") {
    Accounts._enrollAccountToken = token;
  }
});

// Export for testing
AccountsTest = {
  attemptToMatchHash: attemptToMatchHash
};

// XXX these should be moved to accounts-password eventually. Right now
// this is prevented by the need to set autoLoginEnabled=false, but in
// some bright future we won't need to do that anymore.

/**
 * @summary Register a function to call when a reset password link is clicked
 * in an email sent by
 * [`Accounts.sendResetPasswordEmail`](#accounts_sendresetpasswordemail).
 * @param  {Function} callback The function to call. It is given two arguments:
 *
 * 1. A password reset token that can be passed to
 * [`Accounts.resetPassword`](#accounts_resetpassword)
 * 2. The email address to which the email was sent
 * 3. A function to call when the password reset UI flow is complete. The normal
 * login process is suspended until this function is called, so that the
 * password for user A can be reset even if user B was logged in.
 */
Accounts.onResetPasswordLink = function (callback) {
  if (accountsCallbacks["reset-password"]) {
    Meteor._debug("Accounts.onResetPasswordLink was called more than once." +
      "Only the last callback added will be executed.");
  }

  accountsCallbacks["reset-password"] = callback;
};

/**
 * @summary Register a function to call when an email verification link is
 * clicked in an email sent by
 * [`Accounts.sendVerificationEmail`](#accounts_sendverificationemail).
 * @param  {Function} callback The function to call. It is given two arguments:
 *
 * 1. An email verification token that can be passed to
 * [`Accounts.verifyEmail`](#accounts_verifyemail)
 * 2. The email address to which the email was sent
 * 3. A function to call when the email verification UI flow is complete.
 * The normal login process is suspended until this function is called, so
 * that the user can be notified that they are verifying their email before
 * being logged in.
 */
Accounts.onVerifyEmailLink = function (callback) {
  if (accountsCallbacks["verify-email"]) {
    Meteor._debug("Accounts.onVerifyEmailLink was called more than once." +
      "Only the last callback added will be executed.");
  }

  accountsCallbacks["verify-email"] = callback;
};

/**
 * @summary Register a function to call when an account enrollment link is
 * clicked in an email sent by
 * [`Accounts.sendEnrollmentEmail`](#accounts_sendenrollmentemail).
 * @param  {Function} callback The function to call. It is given two arguments:
 *
 * 1. A password reset token that can be passed to
 * [`Accounts.resetPassword`](#accounts_resetpassword) to give the newly
 * enrolled account a password.
 * 2. The email address to which the email was sent
 * 3. A function to call when the enrollment UI flow is complete.
 * The normal login process is suspended until this function is called, so that
 * user A can be enrolled even if user B was logged in.
 */
Accounts.onEnrollAccountLink = function (callback) {
  if (accountsCallbacks["enroll-account"]) {
    Meteor._debug("Accounts.onEnrollAccountLink was called more than once." +
      "Only the last callback added will be executed.");
  }

  accountsCallbacks["enroll-account"] = callback;
};
