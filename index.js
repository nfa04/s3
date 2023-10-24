const { createServer } = require("https");
const { readFileSync } = require("fs");
const { Server } = require('socket.io');
const push = require('web-push');
const port = 443;

const { Client } = require("cassandra-driver");

const httpsServer = createServer({
  key: readFileSync("../keys/priv.pem"),
  cert: readFileSync("../keys/cert.pem")
});

const config = JSON.parse(readFileSync("../.server-vars.json"));

const server = new Server(httpsServer, {
  cors: {
    origin: config['corsAllow'],
    methods: ["GET", "POST"]
  }
});

const CassandraClient = new Client(config['cassandra']);

var mysql = require('mysql2');

var MysqlConnection = mysql.createConnection(config['mysql']);

// Connecting to database
MysqlConnection.connect(function(err) {
  if(err){
    console.log("Error connecting to MySQL DB")
    console.log(err)
  }
});

// Set up push notifications for devices not connected via websocket but connected via the web-push api
push.setVapidDetails(...config['vapid']);


server.on("connection", (socket) => {

  // authenticating the user happens in middleware before all this code is run
  console.log("user connected");

  socket.on("msg", (md) => {

    // Send the message via websockets
    var messageData = JSON.parse(md);
    messageData['s'] = socket.handshake.auth['userID'];
    messageData['sn'] = socket.handshake.auth['userName'];
    socket.to("c:" + messageData['r']).emit("msg", JSON.stringify(messageData));

    // Send the message via web-push
    MysqlConnection.query("SELECT uid FROM chat_memberships WHERE chat_id=?", [messageData['r']], (err, res) => {
      if(err === null) {
        console.log(res);
        res.map(uid => {
          console.log(uid['uid']);
          CassandraClient.execute("SELECT * FROM studezy.push_subscriptions_by_uid WHERE uid=:uid", {
            'uid': uid['uid']
          }, (err, res) => {
            if(err === null)
            res.rows.map(sub => {
              // Don't push the message back to the user which sent it, push it to all others
              if(sub['uid'] != socket.handshake.auth['userID']) push.sendNotification(JSON.parse(sub['data']), JSON.stringify({
                type: 'msg',
                content: messageData['c'],
                userName: socket.handshake.auth['userName'],
                chatID: messageData['r']
              }));
            });
            else console.log(err);
          });
        });
      }
    });

    // Write the message to the database
    CassandraClient.execute("INSERT INTO studezy.messages_by_id (chat_id, content, sent_at, sender, message_id, message_type) VALUES (:chat_id, :content, toTimeStamp(now()), :sender, UUID(), :message_type); ", {
      'content': messageData['c'],
      'sender': messageData['s'],
      'chat_id': messageData['r'],
      'message_type': String.fromCharCode(messageData['t']) // conversion required to be stored as tinyint
    });
  })

  socket.on("fetch_chats", () => {
    MysqlConnection.query("SELECT chat_id, name FROM chats WHERE chat_id=ANY(SELECT chat_id FROM chat_memberships WHERE uid=?)", [
      socket.handshake.auth['userID']
    ], (err, res) => {
      if(err == null) {
        socket.emit("chats_fetched", JSON.stringify(res));
      }
    });
  });

  socket.on("fetch_messages", (chatID) => {
    console.log("fetching")
    MysqlConnection.query("SELECT * FROM chat_memberships WHERE uid=? AND chat_id=?", [
      socket.handshake.auth['userID'],
      chatID
    ], (err, chat) => {
      // User is in this chat, fetch and send the messages
      if(chat !== null && err == null) {
        CassandraClient.execute("SELECT * FROM studezy.messages_by_id WHERE chat_id=:id LIMIT 100", {
          "id": chatID
        }).then((response) => {
          // Now check for read confirmations of last message (others will only be queried on request to save ressources)
          CassandraClient.execute("SELECT COUNT(*) FROM studezy.read_confirmations_by_chat WHERE chat_id=:chid AND message_id=:mid", {
            "chid": chatID,
            "mid": response.rows[0].message_id
          }).then((res) => {
            response.rows[0]['readBy'] = res.rows[0]['count'];
            socket.emit("messages_fetched", JSON.stringify(response.rows));
            // mark all messages in this chat as read by this user as they were just fetched
            for(i = 0; i < response.rowLength; i++) {
              CassandraClient.execute("INSERT INTO studezy.read_confirmations_by_chat (chat_id, user_id, message_id) VALUES (:chid, :uid, :mid) IF NOT EXISTS;", {
                "chid": chatID,
                "uid": socket.handshake.auth['userID'],
                "mid": response.rows[i]['message_id']
              });
            }
          });
        });
      }
    });  
  });

  socket.on("fetch_username", async (userID, complete) => {
    console.log("fetching username for: " + userID);
    // check if the user exists in contacts

    var data = {};

    var contactname = await CassandraClient.execute("SELECT name FROM studezy.contacts_by_owner WHERE owner_id=:oid AND user_id=:uid", {
      "oid": socket.handshake.auth['userID'],
      "uid": userID
    });
    if(contactname.rowLength > 0) data['contactName'] = contactname.rows[0].name;

    var response = await CassandraClient.execute("SELECT uname FROM studezy.users_by_id WHERE uid=:uid", {
      "uid": userID
    });
    data['userName'] = response.rows[0].uname;

    complete(JSON.stringify(data));
  });

  socket.on("contact_create", (d) => {
    var data = JSON.parse(d);
    CassandraClient.execute("INSERT INTO studezy.contacts_by_owner (owner_id, user_id, name) VALUES (:oid, :uid, :name);", {
      "oid": socket.handshake.auth['userID'],
      "uid": data['uid'],
      "name": data['name']
    });
  });

  socket.on("fetch_contacts", (complete) => {
    console.log("looking up contacts for: " + socket.handshake.auth['userID']);
    CassandraClient.execute("SELECT user_id, name FROM studezy.contacts_by_owner WHERE owner_id=:oid", {
      "oid": socket.handshake.auth['userID']
    }).then((res) => {
      complete(JSON.stringify(res.rows));
    });
  });

  socket.on("create_chat", (d, complete) => {
    var data = JSON.parse(d);
    MysqlConnection.query("CALL `create_chat`(?, @p1);", [
      data['name']
    ], (err, r) => {
      if(err === null) {
        data['users'].push(socket.handshake.auth['userID']);
        data['users'].forEach((e) => {
          if(e != socket.handshake.auth['userID']) {
            MysqlConnection.query("INSERT INTO `chat_memberships`(`uid`, `chat_id`, `joined`) VALUES (?,?,CURRENT_TIMESTAMP)", [
              e,
              r[0][0]['chid']
            ]);
          } else {
            MysqlConnection.query("INSERT INTO `chat_memberships`(`uid`, `chat_id`, `joined`, admin) VALUES (?,?,CURRENT_TIMESTAMP, true)", [
              e,
              r[0][0]['chid']
            ]);
          }
        });
        complete(r[0][0]['chid']);
      }
    });
  });

  // Emitted when user is typing
  socket.on("ut", (chatID) => {
    socket.to("c:" + chatID).emit("ut", JSON.stringify({
      "user": socket.handshake.auth['userID'],
      "chat": chatID
    }));
  });

  // Emitted when user stops typing
  socket.on("ust", (chatID) => {
    socket.to("c:" + chatID).emit("ust", chatID);
  });

  socket.on("fsend", (d) => {
    var data = JSON.parse(d);
    console.log(data);
    // check authentification to send this file
    CassandraClient.execute("SELECT fileid FROM studezy.onetime_send_tokens_by_userid WHERE userid=:uid", {
      "uid": socket.handshake.auth['userID']
    }).then(res => {
      if(res.rows[0]["fileid"] == data['fileID']) {
        CassandraClient.execute("INSERT INTO studezy.messages_by_id (chat_id, content, sent_at, sender, message_id, message_type) VALUES (:chat_id, :content, toTimeStamp(now()), :sender, UUID(), :ftype); ", {
          'content': data['fileID'],
          'sender': socket.handshake.auth['userID'],
          'chat_id': data['chatID'],
          'ftype': String.fromCharCode(data['ftype']) // needs to be converted to byte to be stored as tinyint
        });
        console.log("fsend send:");
        console.log(data);
        socket.to("c:" + data['chatID']).emit("msg", JSON.stringify({
          's': socket.handshake.auth['userID'], // sender
          'c': data['fileID'],
          'r': data['chatID'],
          't': data['ftype']
        }));
      }
    });
  });

  socket.on("cmfetch", (chatID, complete) => {
    // Check if the chat exists
    MysqlConnection.query("SELECT * FROM chats WHERE chat_id=?;", [
      chatID
    ], (err, res) => {
      if(err === null) {
        MysqlConnection.query("SELECT uid, joined, admin FROM chat_memberships WHERE chat_id=?", [
          chatID
        ], (err, memberships) => {
          if(err === null && typeof res[0] != "undefined") {
            res[0]['members'] = memberships;
            complete(res[0]);
          }
        });
      }
    });
  });

  socket.on("ruser", (data, complete) => {
    MysqlConnection.query("DELETE FROM chat_memberships WHERE uid=? AND chat_id=?", [
      data['userID'],
      data['chatID']
    ], () => {
      complete();
    });
  });

  socket.on("auser", (data) => {
    MysqlConnection.query("INSERT INTO `chat_memberships`(`uid`, `chat_id`, `joined`) VALUES (?,?,CURRENT_TIMESTAMP)", [
      data['userID'],
      data['chatID']
    ]);
  });

  socket.on("ccname", (data, complete) => { // = change chat name
    // check if the user is admin
    MysqlConnection.query("SELECT admin FROM chat_memberships WHERE uid=? AND chat_id=?", [
      socket.handshake.auth['userID'],
      data['chatID']
    ], (err, res) => {
      if(err === null && res[0]['admin']) {
        MysqlConnection.query("UPDATE `chats` SET `name`=? WHERE chat_id=?", [
          data['name'],
          data['chatID']
        ], (err) => {
          if(err === null) complete();
        });
      }
    });
  });

});

server.use(async (socket, next) => {

  await CassandraClient.connect();

  // verify the user's credentials

  var response = await CassandraClient.execute("SELECT mtoken FROM studezy.users_by_id WHERE uid=:uid", {
    'uid': socket.handshake.auth['userID']
  });

  if(response.rows[0].mtoken == socket.handshake.auth['token']) {
    console.log("User: " + socket.handshake.auth['userID']);
    
    socket.join("u:" + socket.handshake.auth['userID']);
    // fetch all chats the user is in at the moment
    MysqlConnection.query("SELECT chat_id FROM chat_memberships WHERE uid=?", [socket.handshake.auth['userID']], (err, res) => {
      res.forEach(chat_id => {
        socket.join("c:" + chat_id['chat_id']);
      });
    });
  } else {
    // User is presenting wrong credentials, closing the socket
    socket.disconnect();
  }

  next();
});

httpsServer.listen(port);
