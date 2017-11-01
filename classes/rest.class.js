const pm = require('promisemaker'),
      mysql = require('mysql'),
      dateFormat = require('dateformat'),
      bcrypt = require('bcrypt'),
      userRights = require('../user-rights.json');

module.exports = class Rest {

  /* CALL TO INITIALIZE MIDDLEWARE */
  static start(settings) {
    Rest.settings = settings;
    Rest.connectToSql();
    return (...args) => new Rest(...args);
  }

  /* MYSQL CONNECTION METHOD */
  static connectToSql() {
    // Promisify MySQL + create connection named 'db'
    Rest.db = pm(
      mysql.createConnection(Rest.settings.dbCredentials), {
        rejectOnErrors: Rest.settings.runtimeErrors,
        mapArgsToProps: {
          query: ['rows', 'fields']
        }
      }
    );

    Rest.checkDbCredentials();
    Rest.db.query(`SET sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))`);
    Rest.db.query(`SET GLOBAL sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))`);
  }

  static async checkDbCredentials() {
    let r = await Rest.db.query('show tables');
    if (r.constructor == Error) {
      console.log('WRONG PASSWORD:', Rest.settings.dbCredentials.password, '------', r.sqlMessage);
    }
  }

  /* CREATE ONE INSTANCE PER REQUEST */
  constructor(req, res, next) {
    // SAVE REQ,RES,NEXT AS PROPERTIES
    this.req = req;
    this.res = res;
    this.next = next;

    // AN ALIAS FOR SETTINGS, CONNECTED TO 'THIS'
    this.settings = Rest.settings;

    // MAKE SURE THE BASEURL ENDS WITH '/'
    if (this.settings.baseUrl.substr(-1) != '/') {
      this.settings.baseUrl += '/';
    }

    // MAKE SURE THE BASEURL FOR VIDTABLES ENDS WITH '/'
    if (this.settings.baseUrlForVidTables.substr(-1) != '/') {
      this.settings.baseUrlForVidTables += '/';
    }

    this.analyzeUrl();

    // CHECK USER RIGHTS
    if (!this.checkUserRights()) {
      this.res.status(403);
      this.res.json({ Error: 'Not allowed!' });
      return;
    }

    // CALL THE CORRECT METHOD.
    // 'METHOD' COMES FROM 'ANALYZEURL'
    if (['get', 'post', 'put', 'delete'].includes(this.method)) {
      this[this.method]();
    }
  }

  /* ANALYZE THE URL SO IT CAN BE USED TO CALL CORRECT REST METHODS */
  analyzeUrl() {
    let url = this.req.url;
    let method = this.req.method.toLowerCase();
    let hasBaseUrl = url.indexOf(this.settings.baseUrl) == 0;
    let hasBaseUrlVids = url.indexOf(this.settings.baseUrlForVidTables) == 0;
    let baseUrl = this.settings[hasBaseUrl ? 'baseUrl' : 'baseUrlForVidTables'];

    if (!hasBaseUrl && !hasBaseUrlVids) {
      this.next();
      return;
    }

    // REMOVE BASEURL. SPLIT ON '/'
    let urlParts = url.split(baseUrl, 2)[1].split('/');

    // SET PROPERTIES AFTER ANALYSIS
    this.table = '`' + urlParts[0].split(';').join('').split('?')[0] + '`';
    this.id = urlParts[1];
    this.method = method;
    this.idColName = this.settings.idMap[this.table] || 'id';
    this.handleVids = hasBaseUrlVids;
    this.urlQuery = this.req.query;
  }

  checkUserRights() {
    let ok = false;
    let table = this.table.replace(/`/g,'');
    let role = this.req.session.user && this.req.session.user.role;
    if (!role) { role = 'visitor'; }

    let rights = userRights[role];

    if (rights[table]) {
      let okMethods = rights[table];

      if (okMethods.constructor !== Array) {
        // CONVERT TO ARRAY
        okMethods = [okMethods];
      }

      for (let okMethod of okMethods) {
        if (okMethod == this.method) {
          ok = true;
        }
      }

    }

    return ok;
  }

  // AUTOMATICALLY RETURNS THE NEWEST VERSION OF EVERYTHING
  selectVidify() {

    let table = this.table;
    let idColName = this.idColName;

    if (!this.handleVids) {
      return table;
    }

    return `(SELECT x.* FROM
      ( SELECT ${idColName}, MAX(versionId) AS versionId
        FROM ${table}
        GROUP BY ${idColName}
      ) AS version
      JOIN ${table} AS x
      ON version.${idColName} = x.${idColName} && version.versionId = x.versionId) AS alias`;
  }

  async get() {

    let sql = 'SELECT * FROM ' + this.selectVidify(this.table);
    let params = [];
    let limitparams = [];

    if(this.id){
      sql += ' WHERE ' + this.idColName + ' = ?';
      params.push(this.id);
    }
    else {
      sql += '[wherecondition]';
    }

    if(this.urlQuery.order_by){
      sql += ' ORDER BY `' + this.urlQuery.order_by + '`';
    }

    if(this.urlQuery.desc == 1){
      sql += ' DESC';
    }

    if(this.urlQuery.limit){
      sql += ' LIMIT ?';
      limitparams.push(this.urlQuery.limit / 1);
    }

    if(this.urlQuery.offset){
      sql += ' OFFSET ?';
      limitparams.push(this.urlQuery.offset / 1);
    }

    delete this.urlQuery.order_by;
    delete this.urlQuery.desc;
    delete this.urlQuery.limit;
    delete this.urlQuery.offset;

    let where = '';

    for (let columnName in this.urlQuery) {
      let columnVal = decodeURIComponent(this.urlQuery[columnName]);

      columnVal = columnVal.split('*').join('%');

      if (where != '') {
        where += ' && ';
      }

      where += '`' + columnName + '` LIKE ?';

      params.push(isNaN(columnVal / 1) ? columnVal : columnVal / 1);
    }

    if (where != '') {
      sql = sql.split('[wherecondition]').join(' WHERE ' + where + ' ');
    } else {
      sql = sql.split('[wherecondition]').join('');
    }

    params = params.concat(limitparams);

    // console.log(sql,params)
    let result = await this.query(sql,params);

    /* ERROR HANDLING */
    // IF WE  GET AN ERROR FROM MYSQL
    if (result.constructor === Error) {
      this.res.status(500);
    }

    // IF POST CANNOT BE FOUND
    else if (this.id && result.length === 0) {
      this.res.status(500);
      this.res.json({ Error: 'No post could be located' });
      return;
    }

    // CONVERT QUERY FROM ARRAY TO OBJECT
    else if (this.id) {
      result = result[0];
    }

    // RETURN RESULT
    this.res.json(result);
  }

  async delete() {
    let result = await this.query(
      'DELETE FROM ' + this.table + ' WHERE `' + this.idColName + '` = ?',
      [this.id]
    );

    /* ERROR HANDLING */
    // IF WE  GET AN ERROR FROM MYSQL
    if (result.constructor === Error) {
      this.res.status(500);
    }

    // RETURN RESULT
    this.res.json(result);
  }

  async post() {

    if (this.handleVids) {
      // SPLIT UP 'REQ.BODY'
      // BY EXTRACTING KEYS AND VALUES
      let keys = Object.keys(this.req.body);
      let values = Object.values(this.req.body);

      // INSERT INTO TABLE. GIVE VERSION ID = 1 IF IT IS A NEW INSERT
      let query = `INSERT INTO ${this.table} SET
        ${this.idColName} = IFNULL((SELECT MAX(${this.idColName}) + 1 FROM ${this.table} AS x), 1),
        versionId = 1
      `;

      // LOOP THROUGH THE OBJECT KEYS
      for (let key of keys) {
        query += `, ${key} = ?`;
      }

      let result = await this.query(query, values);

      /* ERROR HANDLING */
      // IF WE  GET AN ERROR FROM MYSQL
      if (result.constructor === Error) {
        this.res.status(500);
      }

      // RETURN RESULT
      this.res.json(result);

      return;
    }

    await this.set();
  }

  async put() {

    if (this.handleVids) {
      // FIRST GET OLD INFO FROM TABLE
      // IN CASE WE DON'T WANT TO CHANGE ALL COLUMNS
      let post = (await this.query('SELECT * FROM ' + this.selectVidify() + ' WHERE ' + this.idColName + ' = ?', [this.id]))[0];

      if (!post) {
        this.res.status(500);
        this.res.json({ Error: "A put must have a id in the URL!" });
        return;
      }

      // DELETE PROPERTIES THAT SHALL NOT BE TRANSFERED
      // BETWEEN VERSIONS
      delete post.id;
      delete post.versionId;
      delete post.timeCreated;

      let props = Object.assign({}, post, this.req.body);

      // SPLIT UP 'REQ.BODY'
      // BY EXTRACTING KEYS AND VALUES
      let keys = Object.keys(props);
      let values = Object.values(props);

      let query = `INSERT INTO ${this.table} SET
        id = ${this.id},
        versionId = IFNULL((SELECT MAX(versionId) + 1 FROM ${this.table} AS x WHERE ${this.idColName} = ${this.id}), 1)`;

      for (let key of keys) {
        query += `, ${key} = ?`;
      }

      let result = await this.query(query, values);


      /* ERROR HANDLING */
      // IF WE  GET AN ERROR FROM MYSQL
      if (result.constructor === Error) {
        this.res.status(500);
      }

      // RETURN RESULT
      this.res.json(result);

      return;
    }

    await this.set();

    // MAKE SURE USERS WITH 3 WARNINGS GET THEIR CONTENT DELETED
    if (this.req.body.warnings === 3) {
      this.findUserToBan();
    }

  }

  async set() {
    let query = (this.id ? 'UPDATE ' : 'INSERT INTO ') + this.table + ' SET ? ';

    // CHECK IF THE TABLE IS USERS
    // THEN HASH THE REQ.BODY.PASSWORD
    if (this.table == '`users`' && this.req.body.password) {
      let hash = await bcrypt.hash(this.req.body.password, 12);
      this.req.body.password = hash;
    }

    // run query with or without id
    let result = await this.query(
      query + (this.id ? (' WHERE `' + this.idColName + '` = ?') : ''), [this.req.body, this.id]
    );

    /* ERROR HANDLING */
    // IF WE  GET AN ERROR FROM MYSQL
    if (result.constructor === Error) {
      this.res.status(500);
      result = {
        status: result.sqlMessage
      };
    }

    // RETURN RESULT
    this.res.json(result);
  }

  /* SEARCH FUNCTION */
  async search() {
    /*
      från current_films vill vi ha id, title, year, genre
      från current_actors vill vi ha id, firstName, lastName
      från current_directors vill vi ha id, firstName, lastName
    */

    /* SEARCH THROUGH CURRENT_FILMS */
    let filmsKeyword = 'igh';

    let sqlCurrentFilms = 'SELECT id, title, year, genre FROM current_films WHERE ';
    sqlCurrentFilms += 'title LIKE "%' + filmsKeyword + '%"';
    sqlCurrentFilms += 'OR year LIKE "%' + filmsKeyword + '%"';
    sqlCurrentFilms += 'OR genre LIKE "%' + filmsKeyword + '%"';

    let filmsResult = await this.query(sqlCurrentFilms);

    /* SEARCH THROUGH CURRENT_ACTORS */
    let actorsKeyword = 'ska';

    let sqlCurrentActors = 'SELECT id, firstName, lastName FROM current_actors WHERE ';
    sqlCurrentActors += 'firstName LIKE "%' + actorsKeyword + '%"';
    sqlCurrentActors += 'lastName LIKE "%' + actorsKeyword + '%"';

    let actorsResult = await this.query(sqlCurrentActors);

    /* SEARCH THROUGH CURRENT_DIRECTORS */
    let directorsKeyword = 'ska';

    let sqlCurrentDirectors = 'SELECT id, firstName, lastName FROM current_directors WHERE ';
    sqlCurrentDirectors += 'firstName LIKE "%' + directorsKeyword + '%"';
    sqlCurrentDirectors += 'lastName LIKE "%' + directorsKeyword + '%"';

    let DirectorsResult = await this.query(sqlCurrentDirectors);

    // console.log({
    //   films: filmsResult,
    //   actors: actorsResult,
    //   directors: directorsResult
    // });

    this.res.json({
      films: filmsResult,
      actors: actorsResult,
      directors: directors
    });
  }

  async findUserToBan() {
    // CHECK IF THERE ARE USERS TO BAN & DELETE
    let checkUsers = await this.query('SELECT * FROM users WHERE warnings = 3 && role != "banned"');

    checkUsers.length != 0 ? this.deleteUserPosts(checkUsers) : console.log('Currently no users to ban');

    if (checkUsers.constructor === Error) {
      return;
    }

    this.next();
    return;
  };

  async deleteUserPosts(foundUser) {
    let tables = ['films', 'persons', 'reviews', 'films_actors', 'films_directors'];
    let idColName = 'changerId';
    let userId = foundUser[0].id;

    let ban = await this.query(
      'UPDATE users SET role = "banned" WHERE id = ?', [userId]
    );

    for (let i = 0; i < tables.length; i++) {
      let result = await this.query(
        'DELETE FROM ' + tables[i] + ' WHERE `' + idColName + '` = ?', [userId]
      );
    }
    console.log('Found 3 warnings on ', foundUser);
    console.log('All Posts by User: ', userId, 'has successfully been deleted and user role is now "banned"');
  }

  /* QUERY HELPER FUNCTION */
  async query(query, params) {
    let result = await Rest.db.query(query, params);
    return result.rows;
  }

  /* QUERY HELPER FUNCTION */
  static async query(query, params) {
    let result = await Rest.db.query(query, params);
    return result.rows;
  }

}