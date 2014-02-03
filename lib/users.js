// Copyright 2014 Joyent, Inc.  All rights reserved.

var assert = require('assert');

var util = require('util'),
    sprintf = util.format;

var restify = require('restify'),
    MissingParameterError = restify.MissingParameterError,
    InvalidArgumentError = restify.InvalidArgumentError;


// --- Globals

/* BEGIN JSSTYLED */
var EMAIL_RE = /^[a-zA-Z0-9.!#$%&amp;'*+\-\/=?\^_`{|}~\-]+@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)*$/;
/* END JSSTYLED */

var USER_FMT = 'uuid=%s, ou=users, o=smartdc';

// --- Helpers


// UFDS to CloudAPI account
function translateUser(user) {
    if (!user) {
        return {};
    }

    var u = {
        id: user.uuid,
        login: user.login,
        email: user.email
    };

    if (user.company) {
        u.companyName = user.company;
    }

    if (user.givenname) {
        u.firstName = user.givenname;
    }
    if (user.sn) {
        u.lastName = user.sn;
    }
    if (user.postalcode) {
        u.postalCode = user.postalcode;
    }

    ['address', 'city', 'state',
        'postalCode', 'country', 'phone'].forEach(function (p) {
            if (user[p]) {
                u[p] = user[p];
            }
        });

    u.updated = user.updated_at || 1356994800000;
    u.updated = new Date(parseInt(u.updated, 0)).toISOString();
    // If created_at has no value, set by default to
    // "Tue Jan 01 2013 00:00:00 GMT+0100 (CET)" as "the beginning day"
    u.created = user.created_at || 1356994800000;
    u.created = new Date(parseInt(u.created, 0)).toISOString();

    return (u);
}


// Intentionally skipping login & userpassword here:
function parseParams(req) {
    var modifiableProps = ['email', 'cn', 'sn', 'company', 'address', 'city',
        'state', 'postalCode', 'country', 'phone', 'givenName'];

    var params = {};
    modifiableProps.forEach(function (p) {
        if (req.params[p]) {
            params[p] = req.params[p];
        }
    });
    // We change these, check them too:
    if (req.params.companyName) {
        params.company = req.params.companyName;
    }

    if (req.params.firstName) {
        params.givenName = req.params.firstName;
    }

    if (req.params.lastName) {
        params.sn = req.params.lastName;
    }

    if (req.params.firstName && req.params.lastName) {
        params.cn = req.params.firstName + ' ' + req.params.lastName;
    }

    return (params);
}

// --- Functions

function create(req, res, next) {
    assert.ok(req.sdc);
    assert.ok(req.account);

    var log = req.log;
    var ufds = req.sdc.ufds_master;
    var id = req.account.uuid;
    var errors = [];

    var params = parseParams(req);
    if (!params.email) {
        errors.push('email is required');
    }

    if (req.params.login) {
        params.login = req.params.login;
    } else {
        errors.push('login is required');
    }

    if (req.params.password) {
        params.userpassword = req.params.password;
    } else {
        errors.push('password is required');
    }

    // Fail early:
    if (errors.length) {
        return next(new MissingParameterError(
                'Request is missing required parameters: ' +
                errors.join(', ')));
    }

    // I'd say we should do this at UFDS level but, while we don't make a
    // decission, let's go for it here (see CAPI-120):
    if (!EMAIL_RE.test(params.email)) {
        return next(new InvalidArgumentError('email: ' + params.email +
                ' is invalid'));
    }

    // Important bit here!:
    params.account = id;

    return ufds.addUser(params, function (err, user) {
        if (err) {
            log.error({err: err}, 'Create user error');
            if (err.statusCode === 409 &&
                (err.body.code === 'MissingParameter' ||
                err.body.code === 'InvalidArgument')) {
                var msg = err.message;
                if (/userpassword/.test(msg)) {
                    err.message = msg.replace(/userpassword/g, 'password');
                }
                return next(err);
            } else {
                return next(new InvalidArgumentError('user is invalid'));
            }
        }

        user = translateUser(user);
        res.header('Location', sprintf('/%s/users/%s',
                                    req.account.login,
                                    encodeURIComponent(user.login)));

        log.debug('POST %s => %j', req.path(), user);
        res.send(201, user);
        return next();
    });
}


// NOTE: We are intentionally ignoring login and password changes for now.
function update(req, res, next) {
    assert.ok(req.sdc);
    assert.ok(req.account);

    var log = req.log;
    var ufds = req.sdc.ufds_master;
    var id = req.account.uuid;

    var params = parseParams(req);
    // I'd say we should do this at UFDS level but, while we don't make a
    // decission, let's go for it here (see CAPI-120):
    if (params.email && !EMAIL_RE.test(params.email)) {
        return next(new InvalidArgumentError('email: ' + params.email +
                ' is invalid'));
    }

    //params.account = id;
    return ufds.getUser(req.params.login, id, function (err, user) {
        if (err) {
            return next(err);
        }
        return ufds.updateUser(user, params, id, function (er2) {
            if (er2) {
                return next(er2);
            }
            return ufds.getUser(req.params.login, id, function (er3, u) {
                if (er3) {
                    return next(er3);
                }
                u = translateUser(u);

                log.debug('POST %s => %j', req.path(), u);
                res.send(200, u);
                return next();
            });
        });
    });
}


function list(req, res, next) {
    assert.ok(req.sdc);
    assert.ok(req.account);

    var log = req.log;
    var ufds = req.sdc.ufds_master;
    var id = req.account.uuid;
    var dn = sprintf(USER_FMT, id);

    var opts = {
        scope: 'one',
        filter: '(objectclass=sdcaccountuser)'
    };

    return ufds.search(dn, opts, function (err, users) {
        if (err) {
            return next(err);
        }

        users = users.map(translateUser);
        log.debug('GET %s => %j', req.path(), users);
        res.send(users);
        return next();

    });
}


function get(req, res, next) {
    assert.ok(req.sdc);
    assert.ok(req.account);

    var log = req.log;
    var ufds = req.sdc.ufds_master;
    var id = req.account.uuid;

    return ufds.getUser(req.params.login, id, function (err, user) {
        if (err) {
            return next(err);
        }

        user = translateUser(user);
        log.debug('GET %s => %j', req.path(), user);
        res.send(user);
        return next();
    });
}


function del(req, res, next) {
    assert.ok(req.sdc);
    assert.ok(req.account);

    var log = req.log;
    var ufds = req.sdc.ufds_master;
    var id = req.account.uuid;

    return ufds.deleteUser(req.params.login, id, function (err) {
        if (err) {
            return next(err);
        }

        log.debug('DELETE %s -> ok', req.path());
        res.send(204);
        return next();
    });
}


function mount(server, before) {
    assert.argument(server, 'object', server);
    assert.ok(before);

    server.post({
        path: '/:account/users',
        name: 'CreateUser',
        contentType: [
            'multipart/form-data',
            'application/octet-stream',
            'application/json',
            'text/plain'
        ]
    }, before, create);

    server.get({
        path: '/:account/users',
        name: 'ListUsers'
    }, before, list);

    server.head({
        path: '/:account/users',
        name: 'HeadUsers'
    }, before, list);

    server.get({
        path: '/:account/users/:login',
        name: 'GetUser'
    }, before, get);

    server.head({
        path: '/:account/users/:login',
        name: 'HeadUser'
    }, before, get);

    server.post({
        path: '/:account/users/:login',
        name: 'UpdateUser'
    }, before, update);

    server.del({
        path: '/:account/users/:login',
        name: 'DeleteUser'
    }, before, del);

    return server;
}


// --- API

module.exports = {
    mount: mount
};